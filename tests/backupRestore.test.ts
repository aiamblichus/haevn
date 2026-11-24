import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRestore,
  finishRestore,
  RESTORE_IDLE_MS,
  restoreChat,
  restoreMedia,
} from "../src/background/backup/restoreSession";
import { acquireOperationLock, getActiveOperation } from "../src/background/state";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import { restoreChatRecord, restoreMediaFile } from "../src/services/backup/backupRestore";
import { BackupError, type BackupRecordHeader } from "../src/services/backup/format";
import type { ChatEmbeddingRecord, ChatMetadataRecord } from "../src/services/db";
import { getDB } from "../src/services/db";
import { sweepMedia } from "../src/services/mediaSweep";
import { log } from "../src/utils/logger";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-136 slice 4: the backup service's write side and the restore session. The three rules are
// "a chat or file whose id exists is replaced", "what is missing is added" and "nothing else is
// touched"; each has tests below that fail when the rule is taken out.

const { addOrUpdateChatInIndex, rebuildIndex } = vi.hoisted(() => ({
  addOrUpdateChatInIndex: vi.fn(async (_chatId: string) => {}),
  rebuildIndex: vi.fn(async () => {}),
}));
// The count the session recalculates is the real one (it writes `provider-count:<provider>` into
// the cache table); the spy only records the calls.
const { recalculateProviderStats, realRecalculate } = vi.hoisted(() => ({
  recalculateProviderStats: vi.fn(async (_provider: string): Promise<number> => 0),
  realRecalculate: { fn: null as null | ((provider: string) => Promise<number>) },
}));
const { handleGenerateThumbnails, broadcastChatSynced } = vi.hoisted(() => ({
  handleGenerateThumbnails: vi.fn(async (_chatId: string) => {}),
  broadcastChatSynced: vi.fn((_chat: unknown) => {}),
}));

vi.mock("../src/services/syncService", () => ({
  SyncService: { addOrUpdateChatInIndex, rebuildIndex },
}));
vi.mock("../src/services/cacheService", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/cacheService")>();
  realRecalculate.fn = original.CacheService.recalculateProviderStats;
  return { CacheService: { ...original.CacheService, recalculateProviderStats } };
});
vi.mock("../src/background/handlers/galleryHandlers", () => ({ handleGenerateThumbnails }));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced }));

let fs: FakeOpfs;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function chatRow(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    source: "claude",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1,
    lastSyncedTimestamp: 1_000,
    providerLastModifiedTimestamp: 900,
    checksum: `sum-${id}`,
    syncStatus: "synced",
    deleted: 0,
    ...extra,
  };
}

function message(chatId: string, id: string, text = `text of ${id}`): ChatMessage {
  return {
    id,
    childrenIds: [],
    message: [
      {
        kind: "response",
        timestamp: "2026-01-01T00:00:00.000Z",
        parts: [{ part_kind: "text", content: text }],
      },
    ],
    model: "m",
    done: true,
    chatId,
    timestamp: 1,
  };
}

function metadataOf(chatId: string, title = "Title"): ChatMetadataRecord {
  return {
    chatId,
    title,
    description: "Description",
    synopsis: "Synopsis",
    categories: ["work"],
    keywords: ["alpha", "beta"],
    source: "manual",
    updatedAt: 5,
  };
}

function embeddingOf(chatId: string, model = "embed-model"): ChatEmbeddingRecord {
  return {
    chatId,
    vector: [0.5, -0.25, 0],
    vectorDim: 3,
    model,
    endpointHash: "endpoint",
    inputFingerprint: "input",
    updatedAt: 6,
  };
}

interface Backup {
  chat: Chat;
  messages: ChatMessage[];
  metadata?: ChatMetadataRecord | null;
  embedding?: ChatEmbeddingRecord | null;
}

/** A chat's record as the read side writes it: the header line, then one line per message row. */
function recordText(backup: Backup): string {
  const header: BackupRecordHeader = {
    v: 1,
    chat: backup.chat,
    metadata: backup.metadata ?? null,
    embedding: backup.embedding ?? null,
  };
  return [header, ...backup.messages].map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** The bytes as a stream in chunks of `chunkSize`, which cuts through multi-byte characters. */
function streamOf(text: string, chunkSize = 7): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

function bytesStream(bytes: Uint8Array, chunkSize = 3): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + chunkSize));
      at += chunkSize;
    },
  });
}

const enc = (text: string) => new TextEncoder().encode(text);

/** Every table of the archive and every file of OPFS, as plain data. */
async function dumpArchive(): Promise<{
  tables: Record<string, unknown[]>;
  files: Record<string, string | null>;
}> {
  const db = getDB();
  const tables: Record<string, unknown[]> = {};
  for (const table of db.tables) tables[table.name] = await table.toArray();
  const files: Record<string, string | null> = {};
  for (const path of fs.files()) files[path] = fs.text(path);
  return { tables, files };
}

/** The dump without what is keyed by one of `ids`: chat rows, their messages and their per-chat rows. */
function withoutChats(dump: Awaited<ReturnType<typeof dumpArchive>>, ids: string[]) {
  const gone = new Set(ids);
  const keyOf = (name: string, row: Record<string, unknown>): unknown =>
    name === "chats" ? row.id : row.chatId;
  const keyed = ["chats", "chatMessages", "chatMetadata", "chatEmbeddings", "thumbnails"];
  const tables: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(dump.tables)) {
    tables[name] = keyed.includes(name)
      ? rows.filter((row) => !gone.has(keyOf(name, row as Record<string, unknown>) as string))
      : rows;
  }
  // mediaContent rows share the id of their thumbnail; the chat's own are dropped with them
  const thumbnailIds = new Set(
    (dump.tables.thumbnails as Array<{ id: number; chatId: string }>)
      .filter((t) => gone.has(t.chatId))
      .map((t) => t.id),
  );
  tables.mediaContent = (dump.tables.mediaContent as Array<{ id: number }>).filter(
    (row) => !thumbnailIds.has(row.id),
  );
  // The files of the restored chats' folders (`media/<id>/`) are dropped; the rest must not move
  const folders = ids.map((id) => `media/${id.replace(/[/\\:*?"<>|]/g, "_")}/`);
  const files = Object.fromEntries(
    Object.entries(dump.files).filter(
      ([path]) => !folders.some((folder) => path.startsWith(folder)),
    ),
  );
  return { tables, files };
}

/**
 * An archive with other chats, caches, queues, thumbnails, settings-like rows and files in it, so
 * "nothing else is touched" has something to touch.
 */
async function seedBystanders(): Promise<void> {
  const db = getDB();
  for (const id of ["other1", "other2"]) {
    await db.chats.put(chatRow(id));
    await db.chatMessages.bulkPut([message(id, "m1"), message(id, "m2")]);
    await db.chatMetadata.put(metadataOf(id, `Meta ${id}`));
    await db.chatEmbeddings.put(embeddingOf(id));
    await db.thumbnails.add({
      chatId: id,
      messageId: "m1",
      source: "claude",
      role: "assistant",
      mediaType: "image",
      generatedAt: 3,
    } as never);
    fs.put(`media/${id}/m1_0.png`, `png of ${id}`, 1);
  }
  await db.cache.put({ id: "provider-count:claude", value: 2, timestamp: 1 } as never);
  await db.cache.put({
    id: "sync-status:claude:x",
    value: { synced: false },
    timestamp: 1,
  } as never);
  await db.metadataQueue.put({ chatId: "other1", status: "pending", retries: 0, addedAt: 1 });
  await db.embeddingQueue.put({ chatId: "other2", status: "failed", retries: 3, addedAt: 1 });
  await db.starmapLayout.put({ layoutKey: "k", updatedAt: 1 } as never);
  await db.openwebuiInstances.put({ id: "o", baseUrl: "http://x" } as never);
  fs.put(".haevn-search/index.sqlite", "the search index", 1);
  fs.put("exports/job/staging.json", "{}", 1);
}

beforeEach(async () => {
  fs = new FakeOpfs();
  fs.install();
  const db = getDB();
  await Promise.all(db.tables.map((table) => table.clear()));
  addOrUpdateChatInIndex.mockClear();
  rebuildIndex.mockClear();
  recalculateProviderStats.mockReset();
  recalculateProviderStats.mockImplementation((provider: string) =>
    (realRecalculate.fn as (provider: string) => Promise<number>)(provider),
  );
  handleGenerateThumbnails.mockClear();
  broadcastChatSynced.mockClear();
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
  vi.spyOn(log, "debug").mockImplementation(() => {});
});

afterEach(async () => {
  // A session another test left open holds the lock and the idle timer
  try {
    await finishRestore({ rebuildIndex: false });
  } catch {
    // none was open
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function thrownBy(work: Promise<unknown>): Promise<BackupError> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(BackupError);
    return error as BackupError;
  }
  throw new Error("expected the call to be refused");
}

// ─── Rule 1: replaced ─────────────────────────────────────────────────────────

describe("restoreChatRecord replaces a chat that exists", () => {
  it.each([
    ["older", 500],
    ["newer", 9_000_000],
  ])("ends equal to the record, timestamp included, when the archive's copy is %s", async (_label, archiveTimestamp) => {
    const db = getDB();
    // The archive's copy: other messages, other metadata, other embedding, another sync time
    await db.chats.put(
      chatRow("c1", {
        title: "Old title",
        lastSyncedTimestamp: archiveTimestamp,
        checksum: "old-sum",
        syncStatus: "error",
      }),
    );
    await db.chatMessages.bulkPut([message("c1", "old1"), message("c1", "m1", "stale text")]);
    await db.chatMetadata.put(metadataOf("c1", "Old metadata"));
    await db.chatEmbeddings.put(embeddingOf("c1", "old-model"));

    const backup: Backup = {
      chat: chatRow("c1", { title: "Backed-up title", lastSyncedTimestamp: 1_234 }),
      messages: [message("c1", "m1"), message("c1", "m2")],
      metadata: metadataOf("c1", "Backed-up metadata"),
      embedding: embeddingOf("c1"),
    };
    const result = await restoreChatRecord("c1", streamOf(recordText(backup)));

    expect(result.replaced).toBe(true);
    expect(await db.chats.get("c1")).toEqual(backup.chat);
    expect((await db.chats.get("c1"))?.lastSyncedTimestamp).toBe(1_234);
    expect((await db.chats.get("c1"))?.checksum).toBe("sum-c1");
    expect((await db.chats.get("c1"))?.syncStatus).toBe("synced");
    // The message rows are the record's, and the archive's other rows are gone
    expect(await db.chatMessages.where("chatId").equals("c1").toArray()).toEqual(backup.messages);
    expect(await db.chatMetadata.get("c1")).toEqual(backup.metadata);
    expect(await db.chatEmbeddings.get("c1")).toEqual(backup.embedding);
  });

  it("deletes the thumbnails of the replaced chat and the content they point at, and no other chat's", async () => {
    const db = getDB();
    await db.chats.put(chatRow("c1"));
    const mine = (await db.thumbnails.add({ chatId: "c1", messageId: "m1" } as never)) as number;
    const theirs = (await db.thumbnails.add({ chatId: "c2", messageId: "m1" } as never)) as number;
    await db.mediaContent.bulkPut([
      { id: mine, data: "mine" },
      { id: theirs, data: "theirs" },
    ] as never);

    await restoreChatRecord("c1", streamOf(recordText({ chat: chatRow("c1"), messages: [] })));

    expect(await db.thumbnails.get(mine)).toBeUndefined();
    expect(await db.mediaContent.get(mine)).toBeUndefined();
    expect(await db.thumbnails.get(theirs)).toBeDefined();
    expect(await db.mediaContent.get(theirs)).toBeDefined();
  });

  it("brings back a soft-deleted chat: live again, with no deletedAt", async () => {
    const db = getDB();
    await db.chats.put(chatRow("c1", { deleted: 1, deletedAt: 777 }));

    const result = await restoreChatRecord(
      "c1",
      streamOf(recordText({ chat: chatRow("c1"), messages: [message("c1", "m1")] })),
    );

    expect(result.replaced).toBe(true);
    const row = await db.chats.get("c1");
    expect(row?.deleted).toBe(0);
    expect(row && "deletedAt" in row).toBe(false);
    expect((await db.chats.where("deleted").equals(0).primaryKeys()) as string[]).toEqual(["c1"]);
  });

  it("replaces the chat whole or not at all: a write that fails late undoes the earlier ones", async () => {
    const db = getDB();
    await db.chats.put(chatRow("c1", { title: "Old title" }));
    await db.chatMessages.bulkPut([message("c1", "old1")]);
    const thumbnail = (await db.thumbnails.add({
      chatId: "c1",
      messageId: "old1",
    } as never)) as number;
    await db.mediaContent.put({ id: thumbnail, data: "old" } as never);
    const before = await dumpArchive();
    // The embedding is the last write of the transaction: the chat, its messages and the
    // thumbnail cleanup have been done by then
    vi.spyOn(db.chatEmbeddings, "put").mockRejectedValueOnce(new Error("disk full"));

    await expect(
      restoreChatRecord(
        "c1",
        streamOf(
          recordText({
            chat: chatRow("c1", { title: "New title" }),
            messages: [message("c1", "m1")],
            metadata: metadataOf("c1"),
            embedding: embeddingOf("c1"),
          }),
        ),
      ),
    ).rejects.toThrow("disk full");

    expect(await dumpArchive()).toEqual(before);
  });

  it("makes the chat live even when the record's own row says it was deleted", async () => {
    const db = getDB();
    const deletedInBackup = chatRow("c1", { deleted: 1, deletedAt: 55 });

    await restoreChatRecord("c1", streamOf(recordText({ chat: deletedInBackup, messages: [] })));

    const row = await db.chats.get("c1");
    expect(row?.deleted).toBe(0);
    expect(row && "deletedAt" in row).toBe(false);
  });

  it("leaves the archive's metadata and embedding when the record has none", async () => {
    const db = getDB();
    await db.chats.put(chatRow("c1"));
    await db.chatMetadata.put(metadataOf("c1", "Mine"));
    await db.chatEmbeddings.put(embeddingOf("c1", "mine"));

    await restoreChatRecord("c1", streamOf(recordText({ chat: chatRow("c1"), messages: [] })));

    expect(await db.chatMetadata.get("c1")).toEqual(metadataOf("c1", "Mine"));
    expect(await db.chatEmbeddings.get("c1")).toEqual(embeddingOf("c1", "mine"));
  });

  it("moves the messages of a chat held for the move into their table, as saving does", async () => {
    const db = getDB();
    const held = chatRow("c1", { messages: { m1: message("c1", "m1"), m2: message("c1", "m2") } });

    await restoreChatRecord("c1", streamOf(recordText({ chat: held, messages: [] })));

    expect((await db.chats.get("c1"))?.messages).toEqual({});
    expect((await db.chatMessages.where("chatId").equals("c1").toArray()).map((m) => m.id)).toEqual(
      ["m1", "m2"],
    );
  });

  it("lets a message row of the table win over the same message inline in a held chat's row", async () => {
    const db = getDB();
    const held = chatRow("c1", {
      messages: { m1: message("c1", "m1", "inline text"), m2: message("c1", "m2", "only inline") },
    });

    await restoreChatRecord(
      "c1",
      streamOf(recordText({ chat: held, messages: [message("c1", "m1", "table text")] })),
    );

    const rows = await db.chatMessages.where("chatId").equals("c1").toArray();
    expect(rows).toEqual([message("c1", "m1", "table text"), message("c1", "m2", "only inline")]);
  });

  it("reads a record cut into small chunks, multi-byte text and a megabyte message included", async () => {
    const db = getDB();
    const big = "ö".repeat(600_000);
    const backup: Backup = {
      chat: chatRow("c1", { title: "日本語のタイトル 🌸" }),
      messages: [message("c1", "m1", "emoji 🧵 and 漢字"), message("c1", "m2", big)],
    };

    await restoreChatRecord("c1", streamOf(recordText(backup), 4093));

    expect((await db.chats.get("c1"))?.title).toBe("日本語のタイトル 🌸");
    expect(await db.chatMessages.where("chatId").equals("c1").toArray()).toEqual(backup.messages);
  });
});

// ─── Rule 2: added ────────────────────────────────────────────────────────────

describe("restoreChatRecord adds a chat that is missing", () => {
  it("writes the chat, its messages, its metadata and its embedding", async () => {
    const db = getDB();
    const backup: Backup = {
      chat: chatRow("c9", { lastSyncedTimestamp: 42 }),
      messages: [message("c9", "m1"), message("c9", "m2")],
      metadata: metadataOf("c9"),
      embedding: embeddingOf("c9"),
    };

    const result = await restoreChatRecord("c9", streamOf(recordText(backup)));

    expect(result.replaced).toBe(false);
    expect(await db.chats.get("c9")).toEqual(backup.chat);
    expect(await db.chatMessages.where("chatId").equals("c9").toArray()).toEqual(backup.messages);
    expect(await db.chatMetadata.get("c9")).toEqual(backup.metadata);
    expect(await db.chatEmbeddings.get("c9")).toEqual(backup.embedding);
  });
});

// ─── Rule 3: nothing else ─────────────────────────────────────────────────────

describe("restoreChatRecord and restoreMediaFile touch nothing else", () => {
  it("leaves every table row and every file not keyed by a restored id as it was", async () => {
    const db = getDB();
    await seedBystanders();
    // c1 exists and is replaced (with an orphan file in its folder, which restore must not delete);
    // c2 is added; both come with media.
    await db.chats.put(chatRow("c1", { title: "Old" }));
    await db.chatMessages.put(message("c1", "old"));
    const stale = await db.thumbnails.add({ chatId: "c1", messageId: "old" } as never);
    await db.mediaContent.put({ id: stale as number, data: "x" } as never);
    fs.put("media/c1/orphan.png", "no chat names this", 1);
    fs.put("media/c1/m1_0.png", "old picture", 1);
    // A pending queue row of a restored chat is not restore's to remove
    await db.metadataQueue.put({ chatId: "c1", status: "pending", retries: 1, addedAt: 2 });
    await db.embeddingQueue.put({ chatId: "c2", status: "pending", retries: 0, addedAt: 3 });

    const before = await dumpArchive();

    await restoreMediaFile("c1", "m1_0.png", bytesStream(enc("new picture")), 11);
    await restoreMediaFile("c2", "m1_0.png", bytesStream(enc("c2 picture")), 10);
    await restoreChatRecord(
      "c1",
      streamOf(recordText({ chat: chatRow("c1"), messages: [message("c1", "m1")] })),
    );
    await restoreChatRecord(
      "c2",
      streamOf(
        recordText({
          chat: chatRow("c2"),
          messages: [message("c2", "m1")],
          metadata: metadataOf("c2"),
        }),
      ),
    );

    const after = await dumpArchive();
    expect(withoutChats(after, ["c1", "c2"])).toEqual(withoutChats(before, ["c1", "c2"]));
    // The dump is not blind: the restored chats did change, and the leftover file is still there
    expect(after.tables.chats).not.toEqual(before.tables.chats);
    expect(after.files["media/c1/m1_0.png"]).toBe("new picture");
    expect(after.files["media/c2/m1_0.png"]).toBe("c2 picture");
    expect(after.files["media/c1/orphan.png"]).toBe("no chat names this");
    expect(after.tables.metadataQueue).toEqual(before.tables.metadataQueue);
    expect(after.tables.embeddingQueue).toEqual(before.tables.embeddingQueue);
  });

  it("is a no-op for the rest of the archive when a record is refused, whatever the reason", async () => {
    const base: Backup = {
      chat: chatRow("c1"),
      messages: [message("c1", "m1")],
      metadata: metadataOf("c1"),
    };
    const lines = recordText(base).split("\n").filter(Boolean);
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      [
        "a record for another chat",
        () => restoreChatRecord("c2", streamOf(recordText(base))),
        "BAD_REQUEST",
      ],
      [
        "a record for another chat, with nothing else in it to give it away",
        () => restoreChatRecord("c2", streamOf(recordText({ chat: chatRow("c1"), messages: [] }))),
        "BAD_REQUEST",
      ],
      [
        "a record of a newer version",
        () => restoreChatRecord("c1", streamOf(recordText(base).replace('"v":1', '"v":2'))),
        "BAD_REQUEST",
      ],
      [
        "a metadata row of another chat",
        () =>
          restoreChatRecord(
            "c1",
            streamOf(recordText({ ...base, metadata: metadataOf("someone-else") })),
          ),
        "BAD_REQUEST",
      ],
      [
        "an embedding row of another chat",
        () =>
          restoreChatRecord(
            "c1",
            streamOf(recordText({ ...base, embedding: embeddingOf("someone-else") })),
          ),
        "BAD_REQUEST",
      ],
      [
        "a message row of another chat, after good ones",
        () =>
          restoreChatRecord(
            "c1",
            streamOf(
              recordText({ ...base, messages: [message("c1", "m1"), message("other1", "m9")] }),
            ),
          ),
        "BAD_REQUEST",
      ],
      [
        "a line that is not JSON",
        () => restoreChatRecord("c1", streamOf(`${lines[0]}\n{"id": \n`)),
        "BAD_REQUEST",
      ],
      ["an empty record", () => restoreChatRecord("c1", streamOf("")), "BAD_REQUEST"],
      [
        "a record cut in the middle of a line",
        () => restoreChatRecord("c1", streamOf(recordText(base).slice(0, -20))),
        "PIPE_FAILED",
      ],
      [
        "a record that ends at a line but short of the announced length",
        () => restoreChatRecord("c1", streamOf(`${lines[0]}\n`), recordText(base).length),
        "PIPE_FAILED",
      ],
      [
        "a stream that breaks half way",
        () =>
          restoreChatRecord(
            "c1",
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(enc(`${lines[0]}\n`));
                controller.error(new TypeError("net::ERR_CONTENT_LENGTH_MISMATCH"));
              },
            }),
          ),
        "PIPE_FAILED",
      ],
    ];
    await seedBystanders();
    await getDB().chats.put(chatRow("c1", { title: "Mine" }));
    const before = await dumpArchive();

    for (const [label, run, code] of cases) {
      const error = await thrownBy(run());
      expect(error.code, label).toBe(code);
      expect(await dumpArchive(), label).toEqual(before);
    }
  });
});

// ─── Media files ──────────────────────────────────────────────────────────────

describe("restoreMediaFile", () => {
  it("writes a missing file and replaces an existing one, leaving its neighbours alone", async () => {
    fs.put("media/c1/m1_0.png", "old", 1);
    fs.put("media/c1/m2_0.png", "neighbour", 1);
    fs.put("media/c2/m1_0.png", "other chat", 1);

    expect(await restoreMediaFile("c1", "m1_0.png", bytesStream(enc("replaced!")), 9)).toBe(9);
    expect(await restoreMediaFile("c1", "m3_0.png", bytesStream(enc("added")), 5)).toBe(5);

    expect(fs.text("media/c1/m1_0.png")).toBe("replaced!");
    expect(fs.text("media/c1/m3_0.png")).toBe("added");
    expect(fs.text("media/c1/m2_0.png")).toBe("neighbour");
    expect(fs.text("media/c2/m1_0.png")).toBe("other chat");
  });

  it("writes into the folder the media writer uses, not the literal chat id", async () => {
    await restoreMediaFile("claude:abc/1", "m1_0.png", bytesStream(enc("x")), 1);

    expect(fs.files("media")).toEqual(["media/claude_abc_1/m1_0.png"]);
  });

  it.each([
    ["..", "c1"],
    [".", "c1"],
    ["", "c1"],
    ["a/b.png", "c1"],
    ["..\\x.png", "c1"],
    ["../../.haevn-search/index.sqlite", "c1"],
    ["m1_0.png", ".."],
    ["m1_0.png", "."],
    ["m1_0.png", ""],
  ])("refuses the file name %j in the folder of chat %j before it writes", async (name, chatId) => {
    fs.put("media/c1/keep.png", "keep", 1);
    fs.put(".haevn-search/index.sqlite", "the index", 1);
    const before = await dumpArchive();

    const error = await thrownBy(restoreMediaFile(chatId, name, bytesStream(enc("evil")), 4));

    expect(error.code).toBe("BAD_REQUEST");
    expect(await dumpArchive()).toEqual(before);
  });

  it.each([
    ["shorter", "abc", 5],
    ["longer", "abcdefgh", 5],
  ])("keeps the old file when the body is %s than announced", async (_label, body, announced) => {
    fs.put("media/c1/m1_0.png", "old", 1);

    const error = await thrownBy(
      restoreMediaFile("c1", "m1_0.png", bytesStream(enc(body)), announced),
    );

    expect(error.code).toBe("PIPE_FAILED");
    expect(fs.text("media/c1/m1_0.png")).toBe("old");
    expect(fs.counts.writableAborted).toBe(1);
  });

  it("stops reading a body that runs past the announced length instead of writing all of it", async () => {
    fs.put("media/c1/m1_0.png", "old", 1);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 1000) controller.close();
        else controller.enqueue(enc("abc"));
      },
    });

    const error = await thrownBy(restoreMediaFile("c1", "m1_0.png", endless, 5));

    expect(error.code).toBe("PIPE_FAILED");
    expect(pulled).toBeLessThan(10);
    expect(fs.text("media/c1/m1_0.png")).toBe("old");
  });

  it("keeps the old file when the stream breaks, and reports the break as a failed pipe", async () => {
    fs.put("media/c1/m1_0.png", "old", 1);
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc("par"));
        controller.error(new TypeError("net::ERR_CONTENT_LENGTH_MISMATCH"));
      },
    });

    const error = await thrownBy(restoreMediaFile("c1", "m1_0.png", broken, 9));

    expect(error.code).toBe("PIPE_FAILED");
    expect(fs.text("media/c1/m1_0.png")).toBe("old");
  });
});

// ─── The sweep reaches what restore leaves ────────────────────────────────────

describe("what a replaced chat no longer names", () => {
  it("is left by restore and removed by the media sweep", async () => {
    const day = 24 * 60 * 60 * 1000;
    fs.put("media/c1/gone_0.png", "old orphan", Date.now() - 5 * day);
    fs.put("media/c1/m1_0.png", "old picture", Date.now() - 5 * day);
    await getDB().chats.put(chatRow("c1"));
    await getDB().chatMessages.put(message("c1", "gone"));

    const named = {
      ...message("c1", "m1"),
      message: [
        {
          kind: "response" as const,
          timestamp: "2026-01-01T00:00:00.000Z",
          parts: [
            {
              part_kind: "image-response" as const,
              content: {
                kind: "binary" as const,
                data: "media/c1/m1_0.png",
                media_type: "image/png",
              },
            },
          ],
        },
      ],
    };
    await restoreMediaFile("c1", "m1_0.png", bytesStream(enc("new picture")), 11);
    await restoreChatRecord("c1", streamOf(recordText({ chat: chatRow("c1"), messages: [named] })));

    // Restore deleted nothing
    expect(fs.has("media/c1/gone_0.png")).toBe(true);

    // The sweep, a day later: the file nothing names goes, the one the backup names stays
    const report = await sweepMedia({ now: Date.now() + 2 * day });
    expect(report.files).toBe(1);
    expect(fs.has("media/c1/gone_0.png")).toBe(false);
    expect(fs.text("media/c1/m1_0.png")).toBe("new picture");
  });
});

// ─── The session ──────────────────────────────────────────────────────────────

function chatBody(chatId: string, backup?: Partial<Backup>) {
  const text = recordText({
    chat: chatRow(chatId),
    messages: [message(chatId, "m1")],
    ...backup,
  });
  return async () => ({ stream: streamOf(text, 64), bytes: new TextEncoder().encode(text).length });
}

describe("the restore session and its lock", () => {
  it("takes the lock as import and gives it back when the restore finishes", async () => {
    expect(await getActiveOperation()).toBe("idle");

    const begun = await beginRestore({ chats: 1 });
    expect(await getActiveOperation()).toBe("import");
    // The limit the daemon's own 120 s wait for a frame is built around
    expect(begun.idleTimeoutMs).toBe(120_000);

    await finishRestore({ rebuildIndex: false });
    expect(await getActiveOperation()).toBe("idle");
  });

  it.each([
    "bulkSync",
    "import",
    "bulkExport",
    "providerHealth",
  ] as const)("answers BUSY and writes nothing while %s holds the lock", async (operation) => {
    await acquireOperationLock(operation);
    const openBody = vi.fn(chatBody("c1"));

    const error = await thrownBy(beginRestore({ chats: 1 }));
    expect(error.code).toBe("BUSY");
    expect(error.message).toContain(operation);
    // No session opened, so a chat is refused too, and the lock is not the restore's to release
    const refused = await thrownBy(restoreChat({ chatId: "c1", openBody, index: false }));
    expect(refused.code).toBe("NO_SESSION");
    expect(await getActiveOperation()).toBe(operation);
    expect(await getDB().chats.count()).toBe(0);
  });

  it("answers BUSY to a second restore while one is open", async () => {
    await beginRestore({ chats: 1 });

    const error = await thrownBy(beginRestore({ chats: 1 }));

    expect(error.code).toBe("BUSY");
    expect(await getActiveOperation()).toBe("import");
  });

  it("refuses two begins that race for the lock", async () => {
    const [first, second] = await Promise.allSettled([
      beginRestore({ chats: 1 }),
      beginRestore({ chats: 1 }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
  });

  it("refuses a chat count that is not a whole number", async () => {
    expect((await thrownBy(beginRestore({ chats: -1 }))).code).toBe("BAD_REQUEST");
    expect((await thrownBy(beginRestore({ chats: 1.5 }))).code).toBe("BAD_REQUEST");
    expect(await getActiveOperation()).toBe("idle");
  });

  it("writes nothing and reads no pipe without a session", async () => {
    await seedBystanders();
    const before = await dumpArchive();
    const openBody = vi.fn(chatBody("c1"));

    const chat = await thrownBy(restoreChat({ chatId: "c1", openBody, index: true }));
    const media = await thrownBy(
      restoreMedia({ chatId: "c1", name: "m1_0.png", bytes: 3, openBody }),
    );
    const finish = await thrownBy(finishRestore({ rebuildIndex: true }));

    expect([chat.code, media.code, finish.code]).toEqual([
      "NO_SESSION",
      "NO_SESSION",
      "NO_SESSION",
    ]);
    expect(openBody).not.toHaveBeenCalled();
    expect(await dumpArchive()).toEqual(before);
    expect(rebuildIndex).not.toHaveBeenCalled();
  });

  it("writes nothing once the session is finished", async () => {
    await beginRestore({ chats: 1 });
    await finishRestore({ rebuildIndex: false });
    const before = await dumpArchive();

    const error = await thrownBy(
      restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false }),
    );

    expect(error.code).toBe("NO_SESSION");
    expect(await dumpArchive()).toEqual(before);
  });

  it("restores a chat and a media file through an open session", async () => {
    await beginRestore({ chats: 1 });
    const media = await restoreMedia({
      chatId: "c1",
      name: "m1_0.png",
      bytes: 3,
      openBody: async () => ({ stream: bytesStream(enc("png")), bytes: 3 }),
    });
    const chat = await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: true });
    await finishRestore({ rebuildIndex: false });

    expect(media).toEqual({ bytes: 3 });
    expect(chat).toEqual({ replaced: false });
    expect(fs.text("media/c1/m1_0.png")).toBe("png");
    expect(await getDB().chats.get("c1")).toEqual(chatRow("c1"));
  });

  it("refuses a chat and a media file when the pipe announces no length, and writes nothing", async () => {
    await beginRestore({ chats: 2 });
    const text = recordText({ chat: chatRow("c1"), messages: [message("c1", "m1")] });
    const before = await dumpArchive();

    const chat = await thrownBy(
      restoreChat({
        chatId: "c1",
        index: false,
        openBody: async () => ({ stream: streamOf(text), bytes: null }),
      }),
    );
    const media = await thrownBy(
      restoreMedia({
        chatId: "c1",
        name: "m1_0.png",
        bytes: 3,
        openBody: async () => ({ stream: bytesStream(enc("png")), bytes: null }),
      }),
    );

    expect([chat.code, media.code]).toEqual(["PIPE_FAILED", "PIPE_FAILED"]);
    expect(await dumpArchive()).toEqual(before);
  });

  it("refuses a media file the pipe carries at another length than the request announced", async () => {
    await beginRestore({ chats: 1 });

    const error = await thrownBy(
      restoreMedia({
        chatId: "c1",
        name: "m1_0.png",
        bytes: 3,
        openBody: async () => ({ stream: bytesStream(enc("png")), bytes: 4 }),
      }),
    );

    expect(error.code).toBe("PIPE_FAILED");
    expect(fs.files("media")).toEqual([]);
  });

  it("leaves everything not keyed by a restored id as it was, through a whole session", async () => {
    await seedBystanders();
    await getDB().chats.put(chatRow("c1", { title: "Old" }));
    const before = await dumpArchive();

    await beginRestore({ chats: 2 });
    await restoreMedia({
      chatId: "c2",
      name: "m1_0.png",
      bytes: 3,
      openBody: async () => ({ stream: bytesStream(enc("png")), bytes: 3 }),
    });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: true });
    await restoreChat({ chatId: "c2", openBody: chatBody("c2"), index: true });
    await finishRestore({ rebuildIndex: false });

    // The one write outside the restored ids is the derived count of the provider it touched, and
    // it is the true count of live chats, not a stale or a made-up one.
    const after = await dumpArchive();
    const countRow = (after.tables.cache as Array<{ id: string; value: unknown }>).find(
      (row) => row.id === "provider-count:claude",
    );
    const liveClaude = await getDB()
      .chats.where("deleted")
      .equals(0)
      .filter((c) => c.source === "claude")
      .count();
    expect(liveClaude).toBe(4); // other1, other2, c1 and c2
    expect(countRow?.value).toBe(liveClaude);
    const withoutCount = (dump: typeof after) => ({
      ...dump,
      tables: {
        ...dump.tables,
        cache: (dump.tables.cache as Array<{ id: string }>).filter(
          (row) => row.id !== "provider-count:claude",
        ),
      },
    });
    expect(withoutChats(withoutCount(after), ["c1", "c2"])).toEqual(
      withoutChats(withoutCount(before), ["c1", "c2"]),
    );
    expect(await getActiveOperation()).toBe("idle");
  });
});

describe("the idle timer", () => {
  beforeEach(() => {
    // Only the timers the session sets: the fake IndexedDB and Dexie keep their own clocks
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // The real count asks the stats worker, whose own time limit would be a fake timer here
    recalculateProviderStats.mockImplementation(async () => 0);
  });

  it("frees the lock when no request comes for the idle limit, and closes the session", async () => {
    await beginRestore({ chats: 1 });

    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS - 1);
    expect(await getActiveOperation()).toBe("import");

    await vi.advanceTimersByTimeAsync(1);
    expect(await getActiveOperation()).toBe("idle");
    const error = await thrownBy(
      restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false }),
    );
    expect(error.code).toBe("NO_SESSION");
    expect(await getDB().chats.count()).toBe(0);
  });

  it("counts from the last request, not from the start", async () => {
    await beginRestore({ chats: 2 });
    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS - 1000);
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false });

    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS - 1000);
    expect(await getActiveOperation()).toBe("import");

    await vi.advanceTimersByTimeAsync(1000);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("does not close the session under a request that is still being served", async () => {
    await beginRestore({ chats: 1 });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = restoreChat({
      chatId: "c1",
      index: false,
      openBody: async () => {
        await gate;
        return chatBody("c1")();
      },
    });

    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS * 3);
    expect(await getActiveOperation()).toBe("import");
    release();
    await slow;

    expect(await getDB().chats.get("c1")).toBeDefined();
    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("lets a new restore begin after the old one timed out", async () => {
    await beginRestore({ chats: 1 });
    await vi.advanceTimersByTimeAsync(RESTORE_IDLE_MS);

    await expect(beginRestore({ chats: 1 })).resolves.toBeDefined();
  });
});

describe("what the session does around each chat", () => {
  it("indexes each chat as it is saved in a small run, and rebuilds only when asked", async () => {
    const begun = await beginRestore({ chats: 20 });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: true });
    await restoreChat({ chatId: "c2", openBody: chatBody("c2"), index: false });
    await finishRestore({ rebuildIndex: false });

    expect(begun.indexPerChat).toBe(true);
    expect(addOrUpdateChatInIndex.mock.calls).toEqual([["c1"]]);
    expect(rebuildIndex).not.toHaveBeenCalled();
  });

  it("indexes once at the end in a big run, even when the client forgets to say so", async () => {
    const begun = await beginRestore({ chats: 21 });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: true });
    await finishRestore({ rebuildIndex: false });

    expect(begun.indexPerChat).toBe(false);
    expect(addOrUpdateChatInIndex).not.toHaveBeenCalled();
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
  });

  it("rebuilds at the end when the client asks, with no chat indexed on the way", async () => {
    await beginRestore({ chats: 100 });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false });
    await finishRestore({ rebuildIndex: true });

    expect(addOrUpdateChatInIndex).not.toHaveBeenCalled();
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
  });

  it("keeps a chat that could not be indexed, and says so when it finishes", async () => {
    addOrUpdateChatInIndex.mockRejectedValueOnce(new Error("index worker is down"));
    await beginRestore({ chats: 1 });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: true });
    const result = await finishRestore({ rebuildIndex: false });

    expect(await getDB().chats.get("c1")).toBeDefined();
    expect(result.indexError).toBe("index worker is down");
    expect(await getActiveOperation()).toBe("idle");
  });

  it("releases the lock even when the index rebuild cannot start", async () => {
    rebuildIndex.mockRejectedValueOnce(new Error("no worker"));
    await beginRestore({ chats: 1 });

    const result = await finishRestore({ rebuildIndex: true });

    expect(result.indexError).toBe("no worker");
    expect(await getActiveOperation()).toBe("idle");
  });

  it("starts thumbnails and announces the chat with the backup's own timestamp", async () => {
    await beginRestore({ chats: 1 });
    await restoreChat({
      chatId: "c1",
      openBody: chatBody("c1", { chat: chatRow("c1", { lastSyncedTimestamp: 4_321 }) }),
      index: false,
    });
    await finishRestore({ rebuildIndex: false });

    expect(handleGenerateThumbnails.mock.calls).toEqual([["c1"]]);
    expect(broadcastChatSynced).toHaveBeenCalledTimes(1);
    expect(broadcastChatSynced.mock.calls[0][0]).toMatchObject({
      id: "c1",
      source: "claude",
      lastSyncedTimestamp: 4_321,
      syncStatus: "synced",
    });
  });

  it("recalculates the count of each provider it restored a chat of, once, at the end", async () => {
    await beginRestore({ chats: 3 });
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false });
    await restoreChat({
      chatId: "c2",
      openBody: chatBody("c2", { chat: chatRow("c2", { source: "chatgpt" }) }),
      index: false,
    });
    await restoreChat({ chatId: "c3", openBody: chatBody("c3"), index: false });
    expect(recalculateProviderStats).not.toHaveBeenCalled();

    await finishRestore({ rebuildIndex: false });

    expect(recalculateProviderStats.mock.calls.map(([name]) => name).sort()).toEqual([
      "chatgpt",
      "claude",
    ]);
  });

  it("writes no chat when the record is refused, and the session stays open for the next", async () => {
    await beginRestore({ chats: 2 });

    const error = await thrownBy(
      restoreChat({ chatId: "c1", openBody: chatBody("c2"), index: true }),
    );
    await restoreChat({ chatId: "c1", openBody: chatBody("c1"), index: false });
    await finishRestore({ rebuildIndex: false });

    expect(error.code).toBe("BAD_REQUEST");
    expect(addOrUpdateChatInIndex).not.toHaveBeenCalled();
    expect(broadcastChatSynced).toHaveBeenCalledTimes(1);
    expect((await getDB().chats.toArray()).map((c) => c.id)).toEqual(["c1"]);
  });
});
