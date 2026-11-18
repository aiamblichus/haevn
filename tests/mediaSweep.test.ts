import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ModelMessage } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";
import { JanitorService } from "../src/services/janitorService";
import { MEDIA_SWEEP_MIN_AGE_MS, sweepMedia } from "../src/services/mediaSweep";
import { log } from "../src/utils/logger";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-90: the media sweep deletes what nothing refers to, and every rule that keeps a file safe
// has a test here that fails when the rule is taken out.

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const OLD = NOW - 2 * DAY;
const HOUR_OLD = NOW - 60 * 60 * 1000;
const H = 60 * 60 * 1000;

let fs: FakeOpfs;

function binary(path: string) {
  return { kind: "binary" as const, data: path, media_type: "image/png" };
}

function responseWith(...paths: string[]): ModelMessage {
  return {
    kind: "response",
    timestamp: "2026-01-01T00:00:00.000Z",
    parts: paths.map((p) => ({ part_kind: "image-response" as const, content: binary(p) })),
  };
}

function requestWith(...paths: string[]): ModelMessage {
  return {
    kind: "request",
    parts: [
      {
        part_kind: "user-prompt",
        timestamp: "2026-01-01T00:00:00.000Z",
        content: ["look at this", ...paths.map(binary)],
      },
    ],
  };
}

function message(chatId: string, id: string, ...body: ModelMessage[]): ChatMessage {
  return { id, childrenIds: [], message: body, model: "m", done: true, chatId, timestamp: 1 };
}

async function addChat(
  id: string,
  messages: ChatMessage[],
  extra: Record<string, unknown> = {},
): Promise<void> {
  const db = getDB();
  await db.chats.put({
    id,
    source: "poe",
    sourceId: id,
    title: `Chat ${id}`,
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1,
    deleted: 0,
    ...extra,
  } as never);
  if (messages.length > 0) await db.chatMessages.bulkPut(messages);
}

/** A file in a chat's folder, old enough to be swept unless it is young. */
function file(chatFolder: string, name: string, lastModified = OLD, data = "xxxx"): string {
  const path = `media/${chatFolder}/${name}`;
  fs.put(path, data, lastModified);
  return path;
}

const sweep = (options: { dryRun?: boolean } = {}) => sweepMedia({ now: NOW, ...options });

beforeEach(async () => {
  fs = new FakeOpfs();
  fs.install();
  const db = getDB();
  await Promise.all([
    db.chats.clear(),
    db.chatMessages.clear(),
    db.thumbnails.clear(),
    db.mediaContent.clear(),
    db.cache.clear(),
  ]);
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("what the sweep deletes", () => {
  it("deletes the files of a chat that no message refers to, and keeps the ones that are referenced", async () => {
    const kept = file("c1", "m2_0.png");
    const stale = file("c1", "m1_0.png", OLD, "123456");
    await addChat("c1", [message("c1", "m2", responseWith(kept))]);

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(fs.has(stale)).toBe(false);
    expect(report).toMatchObject({ ran: true, dryRun: false, files: 1, bytes: 6, chats: 1 });
    expect(report.filesScanned).toBe(2);
  });

  it("deletes the files of a folder whose chat does not exist, and the folder", async () => {
    file("gone", "m1_0.png");
    file("gone", "m1_1.png");
    await addChat("c1", [message("c1", "m1", responseWith(file("c1", "m1_0.png")))]);

    const report = await sweep();

    expect(fs.has("media/gone")).toBe(false);
    expect(fs.has("media/c1/m1_0.png")).toBe(true);
    expect(report).toMatchObject({ files: 2, orphanFolders: 1, chats: 0 });
  });

  it("counts a soft-deleted chat as a chat that exists", async () => {
    const kept = file("soft", "m1_0.png");
    await addChat("soft", [message("soft", "m1", responseWith(kept))], {
      deleted: 1,
      deletedAt: NOW - 60_000,
    });

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(report.files).toBe(0);
    expect(report.orphanFolders).toBe(0);
  });

  it("finds the folder of a chat whose id holds characters a path cannot", async () => {
    const kept = file("a_b", "m1_0.png");
    await addChat("a:b", [message("a:b", "m1", responseWith(kept))]);

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(report.orphanFolders).toBe(0);
  });

  it("leaves a folder with a chat in place even when every file in it went", async () => {
    file("c1", "old_0.png");
    await addChat("c1", [message("c1", "m1", responseWith())]);

    await sweep();

    expect(fs.has("media/c1")).toBe(true);
    expect(fs.files("media/c1")).toEqual([]);
  });
});

describe("a file younger than a day is never deleted", () => {
  it("keeps an unreferenced file in a chat's folder, and deletes it once it is a day old", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())]);
    const young = file("c1", "m9_0.png", HOUR_OLD);

    const first = await sweep();
    expect(fs.has(young)).toBe(true);
    expect(first).toMatchObject({ files: 0, tooYoung: 1 });

    // The same file a day later
    const later = await sweepMedia({ now: HOUR_OLD + MEDIA_SWEEP_MIN_AGE_MS });
    expect(fs.has(young)).toBe(false);
    expect(later.files).toBe(1);
  });

  it("keeps the young files of a folder whose chat does not exist, and the folder with them", async () => {
    const young = file("pending", "m1_0.png", HOUR_OLD);
    const old = file("pending", "m0_0.png", OLD);

    await sweep();

    expect(fs.has(young)).toBe(true);
    expect(fs.has(old)).toBe(false);
    expect(fs.has("media/pending")).toBe(true);
  });

  it("does not delete a file whose time says nothing: zero, or in the future", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())]);
    const zero = file("c1", "a_0.png", 0);
    const future = file("c1", "b_0.png", NOW + DAY);

    const report = await sweep();

    expect(fs.has(zero)).toBe(true);
    expect(fs.has(future)).toBe(true);
    expect(report.tooYoung).toBe(2);
  });
});

describe("what counts as a reference", () => {
  it("reads it from the structure: a user's attachment, a response, and binary content nested anywhere", async () => {
    const asked = file("c1", "u_0.png");
    const answered = file("c1", "a_0.png");
    const nested = file("c1", "t_0.png");
    const stray = file("c1", "z_0.png");
    const tool: ModelMessage = {
      kind: "request",
      parts: [
        {
          part_kind: "tool-return",
          tool_name: "draw",
          tool_call_id: "1",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: { result: [{ file: binary(nested) }] },
        },
      ],
    };
    await addChat("c1", [
      message("c1", "u", requestWith(asked)),
      message("c1", "a", responseWith(answered)),
      message("c1", "t", tool),
    ]);

    await sweep();

    expect(fs.files("media/c1")).toEqual([answered, asked, nested].sort());
    expect(fs.has(stray)).toBe(false);
  });

  it("does not take a path written in a message's text for a reference", async () => {
    const named = file("c1", "m1_0.png");
    const text: ModelMessage = {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [{ part_kind: "text", content: `the picture is at ${named}` }],
    };
    await addChat("c1", [message("c1", "m1", text)]);

    await sweep();

    expect(fs.has(named)).toBe(false);
  });

  it("reads messages a chat carries in its own row, from before messages had a table", async () => {
    const kept = file("old-chat", "m1_0.png");
    await addChat("old-chat", [], {
      messages: { m1: message("old-chat", "m1", responseWith(kept)) },
    });

    await sweep();

    expect(fs.has(kept)).toBe(true);
  });

  it("does not let one chat's references protect a file in another chat's folder", async () => {
    // c1 has a folder of its own, which the sweep walks first, and refers to a file in c2's
    const own = file("c1", "m0_0.png");
    const other = file("c2", "m1_0.png");
    await addChat("c1", [message("c1", "m0", responseWith(own, other))]);
    await addChat("c2", [message("c2", "m1", responseWith())]);

    await sweep();

    expect(fs.has(own)).toBe(true);
    expect(fs.has(other)).toBe(false);
  });

  it("counts a string that is a path wherever a writer put it: any key of a message record, or of the chat row, with or without a leading slash", async () => {
    const inMessage = file("c1", "a_0.png");
    const inPart = file("c1", "b_0.png");
    const inRow = file("c1", "c_0.png");
    const inRowSlash = file("c1", "d_0.png");
    const stray = file("c1", "z_0.png");
    const part: ModelMessage = {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [
        {
          part_kind: "text",
          content: "no picture here",
          vendor_metadata: { saved: { path: inPart } },
        } as never,
      ],
    };
    await addChat(
      "c1",
      [{ ...message("c1", "m1", part), extras: { picture: inMessage } } as ChatMessage],
      { attachments: { draw: [inRow] }, files: [`/${inRowSlash}`] },
    );

    await sweep();

    expect(fs.files("media/c1")).toEqual([inMessage, inPart, inRow, inRowSlash].sort());
    expect(fs.has(stray)).toBe(false);
  });
});

function linkOnly(kind: string, partKind: string): ModelMessage {
  return {
    kind: "response",
    timestamp: "2026-01-01T00:00:00.000Z",
    parts: [{ part_kind: partKind, content: { kind, url: "https://cdn.example/x" } } as never],
  };
}

describe("a chat whose media is held only as a link is skipped whole", () => {
  it.each([
    ["image-url", "image-response"],
    ["video-url", "video-response"],
    ["audio-url", "audio-response"],
    ["document-url", "document-response"],
  ])("keeps every file of a chat with a %s part, and says so", async (kind, partKind) => {
    // A re-sync whose download failed: the old file is the only copy, and nothing refers to it
    const only = file("c1", "old_0.png", OLD, "1234");
    const stored = file("c1", "kept_0.png", OLD, "12");
    await addChat("c1", [
      message("c1", "m1", linkOnly(kind, partKind)),
      message("c1", "m2", responseWith(stored)),
    ]);
    const stale = file("c2", "s_0.png");
    await addChat("c2", [message("c2", "m1", responseWith())]);

    const report = await sweep();

    expect(fs.has(only)).toBe(true);
    expect(fs.has(stored)).toBe(true);
    expect(fs.has(stale)).toBe(false);
    expect(report.skippedForRemoteMedia).toEqual({ chats: 1, files: 2 });
    expect(report).toMatchObject({ skippedChats: 1, skippedFiles: 2, skippedBytes: 6, files: 1 });
    expect(report.skipped[0]).toMatchObject({ chatId: "c1", files: 2, bytes: 6 });
  });

  it("holds back a chat with a link in a user's message too", async () => {
    const only = file("c1", "old_0.png");
    const asked: ModelMessage = {
      kind: "request",
      parts: [
        {
          part_kind: "user-prompt",
          timestamp: "2026-01-01T00:00:00.000Z",
          content: ["look", { kind: "image-url", url: "https://cdn.example/x" }],
        },
      ],
    };
    await addChat("c1", [message("c1", "m1", asked)]);

    await sweep();

    expect(fs.has(only)).toBe(true);
  });

  it("sweeps a chat with no link at all", async () => {
    const stale = file("c1", "old_0.png");
    await addChat("c1", [message("c1", "m1", responseWith())]);

    const report = await sweep();

    expect(fs.has(stale)).toBe(false);
    expect(report.skippedForRemoteMedia).toEqual({ chats: 0, files: 0 });
  });
});

describe("a chat saved within the last day is skipped whole", () => {
  it("keeps its unreferenced files until a day after its last save", async () => {
    const stale = file("c1", "old_0.png");
    await addChat("c1", [message("c1", "m1", responseWith())], {
      lastSyncedTimestamp: NOW - 23 * H,
    });

    const first = await sweep();
    expect(fs.has(stale)).toBe(true);
    expect(first).toMatchObject({ skippedChats: 1, skippedFiles: 1, files: 0 });
    expect(first.skipped[0].reason).toContain("saved within the last day");

    await getDB().chats.update("c1", { lastSyncedTimestamp: NOW - 25 * H });
    const later = await sweep();
    expect(fs.has(stale)).toBe(false);
    expect(later.files).toBe(1);
  });

  it("goes by the latest save when two chat ids share a folder", async () => {
    const stale = file("a_b", "old_0.png");
    await addChat("a:b", [message("a:b", "m1", responseWith())], {
      lastSyncedTimestamp: NOW - 25 * H,
    });
    await addChat("a_b", [message("a_b", "m1", responseWith())], {
      lastSyncedTimestamp: NOW - H,
    });

    await sweep();

    expect(fs.has(stale)).toBe(true);
  });

  it("keeps them when the save is dated in the future", async () => {
    const stale = file("c1", "old_0.png");
    await addChat("c1", [message("c1", "m1", responseWith())], {
      lastSyncedTimestamp: NOW + DAY,
    });

    await sweep();

    expect(fs.has(stale)).toBe(true);
  });
});

describe("a chat that cannot be read is skipped whole", () => {
  it("counts the files that stayed in a skipped chat", async () => {
    file("odd", "a_0.png", OLD, "1234");
    file("odd", "b_0.png", OLD, "123456");
    const bad: ModelMessage = {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [{ part_kind: "image-response", content: { kind: "binary" } }] as never,
    };
    await addChat("odd", [message("odd", "m0", bad)]);

    const report = await sweep();

    expect(report).toMatchObject({ skippedChats: 1, skippedFiles: 2, skippedBytes: 10 });
    expect(report.skipped[0]).toMatchObject({ chatId: "odd", files: 2, bytes: 10 });
  });

  it("skips a chat whose messages fail to load, and sweeps the others", async () => {
    const unknown = file("broken", "m1_0.png");
    const stale = file("fine", "m9_0.png");
    await addChat("broken", [message("broken", "m1", responseWith(unknown))]);
    await addChat("fine", [message("fine", "m1", responseWith())]);

    const db = getDB();
    const where = db.chatMessages.where.bind(db.chatMessages);
    vi.spyOn(db.chatMessages, "where").mockImplementation(((index: string) => {
      const query = where(index);
      return {
        equals: (value: string) => {
          if (value === "broken") throw new Error("the database was busy");
          return query.equals(value);
        },
      };
    }) as never);

    const report = await sweep();

    expect(fs.has(unknown)).toBe(true);
    expect(fs.has(stale)).toBe(false);
    expect(report.skippedChats).toBe(1);
    expect(report.skipped[0]).toMatchObject({ chatId: "broken" });
  });

  it("skips a chat that holds binary content with no path", async () => {
    const files = [file("odd", "a_0.png"), file("odd", "b_0.png")];
    const bad: ModelMessage = {
      kind: "response",
      timestamp: "2026-01-01T00:00:00.000Z",
      parts: [
        { part_kind: "image-response", content: { kind: "binary", media_type: "image/png" } },
      ] as never,
    };
    await addChat("odd", [message("odd", "m0", responseWith(files[0])), message("odd", "m1", bad)]);

    const report = await sweep();

    expect(fs.files("media/odd")).toEqual(files);
    expect(report.skippedChats).toBe(1);
  });

  it("skips a chat with a message that has no body", async () => {
    const kept = file("odd", "a_0.png");
    await addChat("odd", [{ ...message("odd", "m0"), message: undefined } as never]);

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(report.skippedChats).toBe(1);
  });

  it("skips a chat whose own row carries a message with no body", async () => {
    const kept = file("odd", "a_0.png");
    await addChat("odd", [message("odd", "m1", responseWith())], {
      messages: { m2: { ...message("odd", "m2"), message: undefined } },
    });

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(report.skippedChats).toBe(1);
  });

  it("skips a chat that has files and no messages at all", async () => {
    const kept = file("empty", "a_0.png");
    await addChat("empty", []);

    const report = await sweep();

    expect(fs.has(kept)).toBe(true);
    expect(report.skippedChats).toBe(1);
  });
});

describe("a file that cannot be deleted", () => {
  it("is counted and left for the next run, and does not stop the others", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())]);
    const stuck = file("c1", "a_0.png");
    const other = file("c1", "b_0.png");
    fs.failures.removeEntryThrows = new Set(["a_0.png"]);

    const report = await sweep();

    expect(fs.has(stuck)).toBe(true);
    expect(fs.has(other)).toBe(false);
    expect(report).toMatchObject({ files: 1, failedDeletes: 1 });
  });
});

describe("only media/ is touched", () => {
  it("leaves the search index, exports, import staging and stray files beside the media folders", async () => {
    fs.put(".haevn-search/index.db", "db", OLD);
    fs.put(".haevn-search/wal/0", "wal", OLD);
    fs.put("exports/e1/haevn_export.zip", "zip", OLD);
    fs.put("import-staging/1-abc-file.zip", "zip", OLD);
    fs.put("media/stray.bin", "x", OLD);
    file("gone", "m1_0.png");
    const before = fs.files().filter((p) => !p.startsWith("media/gone"));

    await sweep();

    expect(fs.files()).toEqual(before);
  });
});

describe("the gallery rows of a deleted file", () => {
  async function addGalleryRow(chatId: string, messageId: string, path: string): Promise<number> {
    const db = getDB();
    const id = (await db.thumbnails.add({
      chatId,
      messageId,
      source: "poe",
      mediaType: "image/png",
      role: "assistant",
      thumbnail: "data:image/png;base64,AAAA",
      chatTitle: "t",
      generatedAt: 1,
    })) as number;
    await db.mediaContent.add({ id, content: path });
    return id;
  }

  it("go with it, and the rows of a file that stays do not", async () => {
    const kept = file("c1", "m2_0.png");
    const stale = file("c1", "m1_0.png");
    await addChat("c1", [message("c1", "m2", responseWith(kept))]);
    const staleId = await addGalleryRow("c1", "m1", stale);
    const keptId = await addGalleryRow("c1", "m2", kept);

    const report = await sweep();

    const db = getDB();
    expect(await db.thumbnails.get(staleId)).toBeUndefined();
    expect(await db.mediaContent.get(staleId)).toBeUndefined();
    expect(await db.thumbnails.get(keptId)).toBeDefined();
    expect(await db.mediaContent.get(keptId)).toBeDefined();
    expect(report).toMatchObject({ thumbnailRows: 1, contentRows: 1 });
  });

  it("go with the files of a folder that has no chat", async () => {
    const stale = file("gone", "m1_0.png");
    const id = await addGalleryRow("gone", "m1", stale);

    await sweep();

    expect(await getDB().thumbnails.get(id)).toBeUndefined();
    expect(await getDB().mediaContent.get(id)).toBeUndefined();
  });
});

describe("a dry run", () => {
  it("reports what a sweep would do and deletes and writes nothing", async () => {
    const kept = file("c1", "m2_0.png");
    const stale = file("c1", "m1_0.png", OLD, "123456");
    const orphan = file("gone", "m1_0.png");
    await addChat("c1", [message("c1", "m2", responseWith(kept))]);
    // A chat with a link-only image is skipped, and the dry run says so as the real run will
    file("link", "old_0.png", OLD, "123");
    await addChat("link", [message("link", "m1", linkOnly("image-url", "image-response"))]);
    const db = getDB();
    const id = (await db.thumbnails.add({
      chatId: "c1",
      messageId: "m1",
      source: "poe",
      mediaType: "image/png",
      role: "assistant",
      thumbnail: "x",
      chatTitle: "t",
      generatedAt: 1,
    })) as number;
    await db.mediaContent.add({ id, content: stale });
    const before = fs.files();

    const dry = await sweep({ dryRun: true });

    expect(fs.files()).toEqual(before);
    expect(await db.thumbnails.get(id)).toBeDefined();
    expect(dry).toMatchObject({
      dryRun: true,
      files: 2,
      bytes: 10,
      chats: 1,
      orphanFolders: 1,
      thumbnailRows: 1,
      contentRows: 1,
      skippedChats: 1,
      skippedFiles: 1,
      skippedBytes: 3,
      skippedForRemoteMedia: { chats: 1, files: 1 },
    });

    const real = await sweep();
    expect(fs.has(stale)).toBe(false);
    expect(fs.has(orphan)).toBe(false);
    expect({ ...real, dryRun: true, durationMs: 0 }).toEqual({ ...dry, durationMs: 0 });
  });
});

describe("an empty folder with no chat", () => {
  it("is removed by a sweep and left alone by a dry run", async () => {
    fs.mkdir("media/empty");

    await sweep({ dryRun: true });
    expect(fs.has("media/empty")).toBe(true);

    const report = await sweep();
    expect(fs.has("media/empty")).toBe(false);
    expect(report).toMatchObject({ orphanFolders: 1, files: 0 });
  });
});

describe("how a run goes", () => {
  it("logs a summary with the files, bytes and chats", async () => {
    file("gone", "m1_0.png", OLD, "1234");
    await sweep();

    const summary = vi
      .mocked(log.info)
      .mock.calls.map((c) => String(c[0]))
      .find((line) => line.includes("[MediaSweep] Swept"));
    expect(summary).toContain("1 files, 4 bytes");
    expect(summary).toContain("0 chats");
  });

  it("logs each chat that lost files with its id, source, file count and bytes, and no file names", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())], { source: "poe" });
    file("c1", "secret-name_0.png", OLD, "12345");
    file("c1", "other-name_1.png", OLD, "12");
    await addChat("c2", [message("c2", "m1", responseWith(file("c2", "kept_0.png")))]);

    await sweep();

    const lines = vi.mocked(log.info).mock.calls.map((c) => String(c[0]));
    const chatLines = lines.filter((l) => l.includes("Chat c1"));
    expect(chatLines).toHaveLength(1);
    expect(chatLines[0]).toContain("poe");
    expect(chatLines[0]).toContain("2 files, 7 bytes");
    expect(lines.some((l) => l.includes("Chat c2"))).toBe(false);
    expect(lines.some((l) => l.includes("secret-name") || l.includes("other-name"))).toBe(false);
  });

  it("logs no chat line for a dry run", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())]);
    file("c1", "a_0.png");

    await sweep({ dryRun: true });

    const lines = vi.mocked(log.info).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("Chat c1"))).toBe(false);
  });

  it("yields to the event loop while it works through many files", async () => {
    await addChat("c1", [message("c1", "m1", responseWith())]);
    for (let i = 0; i < 120; i++) file("c1", `s${i}_0.png`);
    const timers = vi.spyOn(globalThis, "setTimeout");

    const report = await sweep();

    expect(report.files).toBe(120);
    // One yield per folder, and one for every fifty files
    expect(timers.mock.calls.filter((c) => c[1] === 0).length).toBeGreaterThanOrEqual(3);
  });

  it("does nothing, and says so, when another sweep is running", async () => {
    file("gone", "m1_0.png");
    fs.install({
      locks: { request: async (_n: string, _o: unknown, cb: (l: null) => unknown) => cb(null) },
    });

    const report = await sweep();

    expect(report.ran).toBe(false);
    expect(fs.has("media/gone/m1_0.png")).toBe(true);
  });

  it("runs one sweep at a time within a context", async () => {
    file("gone", "m1_0.png");
    const [first, second] = await Promise.all([sweep(), sweep()]);
    expect([first.ran, second.ran].sort()).toEqual([false, true]);
  });
});

describe("the Janitor's daily sweep", () => {
  const LAST_RUN = "janitor:media-sweep:last-run";
  const FIRST_SEEN = "janitor:media-sweep:first-seen";
  const lastRun = () => getDB().cache.get(LAST_RUN);
  const firstSeen = () => getDB().cache.get(FIRST_SEEN);
  const setRow = (id: string, ago: number) =>
    getDB().cache.put({ id, value: Date.now() - ago, lastUpdated: 0 });
  const HOUR = 60 * 60 * 1000;

  it("on its first start deletes nothing and records when it first looked", async () => {
    const stale = file("gone", "m1_0.png");

    expect(await JanitorService.sweepMediaIfDue()).toBeNull();

    expect(fs.has(stale)).toBe(true);
    expect(typeof (await firstSeen())?.value).toBe("number");
    expect(await lastRun()).toBeUndefined();
  });

  it("keeps waiting until the first look is a day old, then sweeps", async () => {
    const stale = file("gone", "m1_0.png");
    await setRow(FIRST_SEEN, 23 * HOUR);

    expect(await JanitorService.sweepMediaIfDue()).toBeNull();
    expect(fs.has(stale)).toBe(true);
    expect(await lastRun()).toBeUndefined();

    await setRow(FIRST_SEEN, 25 * HOUR);
    const report = await JanitorService.sweepMediaIfDue();

    expect(report?.files).toBe(1);
    expect(fs.has(stale)).toBe(false);
    expect(typeof (await lastRun())?.value).toBe("number");
  });

  it("does not move the first-seen time on later starts", async () => {
    await JanitorService.sweepMediaIfDue();
    const first = (await firstSeen())?.value;
    await JanitorService.sweepMediaIfDue();
    expect((await firstSeen())?.value).toBe(first);
  });

  it("sweeps at most once a day after the first sweep", async () => {
    await setRow(FIRST_SEEN, 25 * HOUR);
    expect((await JanitorService.sweepMediaIfDue())?.ran).toBe(true);

    const second = file("gone2", "m1_0.png");
    expect(await JanitorService.sweepMediaIfDue()).toBeNull();
    expect(fs.has(second)).toBe(true);

    await setRow(LAST_RUN, DAY + 1000);
    const third = await JanitorService.sweepMediaIfDue();
    expect(third?.files).toBe(1);
    expect(fs.has(second)).toBe(false);
  });

  it("does not make a sweep that has already run wait again", async () => {
    const stale = file("gone", "m1_0.png");
    await setRow(LAST_RUN, 2 * DAY);
    await setRow(FIRST_SEEN, HOUR);

    expect((await JanitorService.sweepMediaIfDue())?.files).toBe(1);
    expect(fs.has(stale)).toBe(false);
  });

  it("does not count a sweep that another one made unnecessary", async () => {
    await setRow(FIRST_SEEN, 25 * HOUR);
    fs.install({
      locks: { request: async (_n: string, _o: unknown, cb: (l: null) => unknown) => cb(null) },
    });

    const report = await JanitorService.sweepMediaIfDue();

    expect(report?.ran).toBe(false);
    expect(await lastRun()).toBeUndefined();
  });
});

describe("haevnDebug.mediaSweep", () => {
  it("is a dry run unless told otherwise, at any time, and sweeps at once when told to", async () => {
    const { haevnDebug } = await import("../src/options/debug");
    const stale = file("gone", "m1_0.png");
    // The Janitor has only just looked: its sweep is still waiting
    await getDB().cache.put({
      id: "janitor:media-sweep:first-seen",
      value: Date.now(),
      lastUpdated: 0,
    });

    const dry = await haevnDebug.mediaSweep();
    expect(dry).toMatchObject({ dryRun: true, files: 1 });
    expect(fs.has(stale)).toBe(true);

    const real = await haevnDebug.mediaSweep({ dryRun: false });
    expect(real).toMatchObject({ dryRun: false, files: 1 });
    expect(fs.has(stale)).toBe(false);
  });
});
