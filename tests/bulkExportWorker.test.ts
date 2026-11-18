import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportOptions } from "../src/formatters";
import type { Chat } from "../src/model/haevn_model";
import type { HaevnDatabase } from "../src/services/db";
import { buildExportZipPath } from "../src/services/exportStaging";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The worker opens its own database; keep each one so a test can hold or fail the chat loads.
const workerDbs = vi.hoisted(() => [] as HaevnDatabase[]);
vi.mock("../src/services/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/db")>();
  class TrackedDatabase extends original.HaevnDatabase {
    constructor() {
      super();
      workerDbs.push(this);
    }
  }
  return { ...original, HaevnDatabase: TrackedDatabase };
});

// Staging is OPFS; a start creates its staging directory, which is all these tests need from it.
const stagedExports = vi.hoisted(() => [] as string[]);
vi.mock("../src/services/exportStaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/exportStaging")>()),
  ensureExportStagingDirectories: async (exportId: string) => {
    stagedExports.push(exportId);
  },
}));

// OPFS is an in-memory map here, so a test can read back what the job staged and zipped.
// `onWrite` lets a test act while a file is being written (a pause that lands mid-chat).
const opfs = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  onWrite: undefined as ((path: string) => Promise<void> | void) | undefined,
}));
vi.mock("../src/utils/opfs", async (importOriginal) => {
  const encoder = new TextEncoder();
  const bytesOf = (data: string | Uint8Array) =>
    typeof data === "string" ? encoder.encode(data) : data;
  const join = (parts: Uint8Array[]) => {
    const all = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.byteLength;
    }
    return all;
  };
  const children = (dir: string) => {
    const prefix = `${dir}/`;
    return [...opfs.files.keys()]
      .filter((path) => path.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  };
  return {
    ...(await importOriginal<typeof import("../src/utils/opfs")>()),
    writeFile: async (path: string, data: string | Uint8Array) => {
      await opfs.onWrite?.(path);
      opfs.files.set(path, bytesOf(data));
    },
    appendTextFile: async (path: string, text: string) => {
      opfs.files.set(path, join([opfs.files.get(path) ?? new Uint8Array(), bytesOf(text)]));
    },
    getFile: async (path: string) => {
      const bytes = opfs.files.get(path);
      return bytes ? new File([bytes], path.split("/").pop() ?? path) : null;
    },
    listFiles: async (dir: string) => children(dir).filter((name) => !name.includes("/")),
    listDirectories: async (dir: string) => [
      ...new Set(
        children(dir)
          .filter((name) => name.includes("/"))
          .map((n) => n.split("/")[0]),
      ),
    ],
    // A stream that zip.js can pipe to, with the write and close the manifest writer calls.
    createWritableStream: async (path: string) => {
      await opfs.onWrite?.(path);
      const chunks: Uint8Array[] = [];
      const store = () => opfs.files.set(path, join(chunks));
      const stream = new WritableStream<Uint8Array>({
        write: (chunk) => void chunks.push(chunk),
        close: store,
      });
      return Object.assign(stream, {
        write: async (data: string | Uint8Array) => void chunks.push(bytesOf(data)),
        close: async () => store(),
      });
    },
  };
});

// The worker talks through `self`; stand one in, import the module (which installs
// `self.onmessage`), and drive it with the messages the service worker sends.
type Posted = { type: string; requestId?: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  setTimeout: typeof setTimeout;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
let workerSelf: WorkerGlobal;
let chatLoads: string[] = [];
// Chats the database holds for a test (ids not in it, and not "a…", are not found), and what
// happens when one is loaded.
let chatRows = new Map<string, Chat>();
let onChatLoad: ((id: string) => Promise<void> | void) | undefined;
// Chat "a0" waits on this before it answers; a test replaces it to hold the first batch.
let firstLoad: Promise<void> = Promise.resolve();

const EXPORT_REFUSED = "An export is already running in the worker.";
const OPTIONS = {} as ExportOptions;
const META = {
  haevnVersion: "test",
  exportVersion: "1",
  exportTimestamp: "2026-11-18T00:00:00.000Z",
};
// 101 chats make two batches; chat "a100" is the first of the second, and it fails to load.
const TWO_BATCHES = Array.from({ length: 101 }, (_, i) => `a${i}`);

async function loadWorker(): Promise<void> {
  vi.resetModules();
  posted = [];
  chatLoads = [];
  chatRows = new Map();
  onChatLoad = undefined;
  opfs.files.clear();
  opfs.onWrite = undefined;
  stagedExports.length = 0;
  firstLoad = Promise.resolve();
  workerSelf = {
    postMessage: (message) => posted.push(message),
    // buildZipFromStaging times each step with `self.setTimeout`.
    setTimeout: globalThis.setTimeout.bind(globalThis),
  };
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/bulkExport/bulkExport.worker");

  const db = workerDbs.at(-1);
  if (!db) throw new Error("the worker did not open its database");
  vi.spyOn(db.chats, "get").mockImplementation(async (id: string) => {
    chatLoads.push(id);
    if (chatRows.has(id)) {
      await onChatLoad?.(id);
      return chatRows.get(id);
    }
    if (id === "a0") await firstLoad;
    if (id === "a100") throw new Error("boom");
    return undefined;
  });
}

/** Holds the first batch at its first chat until the returned function is called. */
function holdFirstLoad(): () => void {
  let release!: () => void;
  firstLoad = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

function send(message: Record<string, unknown>): Promise<void> {
  if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
  return workerSelf.onmessage({ data: message });
}

function startMessage(requestId: string, exportId: string, chatIds: string[]) {
  return { type: "start", requestId, exportId, chatIds, options: OPTIONS, meta: META };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a second bulk export start while a job runs or is paused (HVN-55)", () => {
  it("refuses it, and the running job keeps its own batches", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    await send(startMessage("r2", "e2", ["b0", "b1", "b2"]));

    expect(posted).toContainEqual({ type: "error", error: EXPORT_REFUSED, requestId: "r2" });
    expect(stagedExports).toEqual(["e1"]);
    expect(chatLoads.filter((id) => id.startsWith("b"))).toEqual([]);

    release();
    await first;
    // The first job's second batch is its own: 101 chats in two batches, failing on its chat.
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "progress",
        requestId: "r1",
        total: 101,
        totalBatches: 2,
        status: "Processing batch 2/2...",
      }),
    );
    expect(posted).toContainEqual({ type: "error", error: "boom", requestId: "r1" });
  });

  it("refuses it while the running job is paused", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    posted = [];
    await send({ type: "pause", requestId: "p1" });
    expect(posted).toEqual([{ type: "paused", requestId: "p1" }]);

    posted = [];
    await send(startMessage("r2", "e2", ["b0"]));
    expect(posted).toEqual([{ type: "error", error: EXPORT_REFUSED, requestId: "r2" }]);
    expect(stagedExports).toEqual(["e1"]);

    // The paused job ends at its batch boundary; cancel then clears it.
    release();
    await first;
    expect(posted).toContainEqual(expect.objectContaining({ type: "paused", requestId: "r1" }));
    posted = [];
    await send({ type: "cancel" });
    expect(posted).toEqual([expect.objectContaining({ type: "cancelled" })]);
  });

  it("accepts a start once the job has completed", async () => {
    await loadWorker();
    await send(startMessage("r1", "e1", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r1" }));

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted.some((m) => m.type === "error")).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("accepts a start once the job has failed", async () => {
    await loadWorker();
    await send(startMessage("r1", "e1", TWO_BATCHES));
    expect(posted).toContainEqual({ type: "error", error: "boom", requestId: "r1" });

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("accepts a start once the job has been cancelled", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    await send({ type: "cancel" });
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled" }));

    // The batch that was in flight when the cancel landed ends before the next start.
    release();
    await first;

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });
});

// ---- HVN-60: the queue and a pause ------------------------------------------------------------

/** `count` chats c0..c(count-1) (or with another prefix), the database holding all of them. */
function seedChats(
  count: number,
  attachmentsOf: Record<string, number> = {},
  prefix = "c",
): string[] {
  const ids = Array.from({ length: count }, (_, i) => `${prefix}${i}`);
  for (const id of ids) {
    const attachments = attachmentsOf[id] ?? 0;
    const messages =
      attachments === 0
        ? {}
        : {
            m1: {
              id: "m1",
              message: [
                {
                  kind: "request",
                  parts: [
                    {
                      part_kind: "user-prompt",
                      content: Array.from({ length: attachments }, (_, n) => ({
                        kind: "binary",
                        data: btoa(`${id}-${n}`),
                        media_type: "image/png",
                      })),
                    },
                  ],
                },
              ],
            },
          };
    chatRows.set(id, {
      id,
      source: "claude",
      sourceId: `s-${id}`,
      title: id,
      messages,
    } as unknown as Chat);
  }
  return ids;
}

function stagedChatIds(exportId: string): string[] {
  const prefix = `exports/${exportId}/staging/chats/`;
  return [...opfs.files.keys()]
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).replace(/\.json$/, ""));
}

function manifestLines(exportId: string, name: "chats" | "media"): Record<string, unknown>[] {
  const bytes = opfs.files.get(`exports/${exportId}/staging/manifest/${name}.jsonl`);
  if (!bytes) return [];
  return new TextDecoder()
    .decode(bytes)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function zipEntryNames(exportId: string): Promise<string[]> {
  const bytes = opfs.files.get(buildExportZipPath(exportId));
  if (!bytes) return [];
  const { ZipReader, BlobReader } = await import("@zip.js/zip.js");
  const reader = new ZipReader(new BlobReader(new Blob([bytes])));
  const entries = await reader.getEntries();
  await reader.close();
  return entries.map((entry) => entry.filename);
}

describe("a pause that lands mid-batch (HVN-60)", () => {
  it("keeps the unprocessed rest of the batch, and a resume exports every chat", async () => {
    await loadWorker();
    const ids = seedChats(101);
    // The pause lands while the first chat of the first batch is being loaded.
    onChatLoad = async (id) => {
      if (id === "c0") await send({ type: "pause" });
    };

    await send(startMessage("r1", "e1", ids));
    // Paused after one chat: that chat is staged, nothing else is, and nothing was dropped.
    expect(stagedChatIds("e1")).toEqual(["c0"]);
    expect(posted).toContainEqual(expect.objectContaining({ type: "paused", requestId: "r1" }));
    expect(posted.some((m) => m.type === "batchComplete")).toBe(false);
    expect(posted.some((m) => m.type === "complete")).toBe(false);

    onChatLoad = undefined;
    posted = [];
    await send({ type: "resume" });

    expect(stagedChatIds("e1").sort()).toEqual([...ids].sort());
    expect(
      manifestLines("e1", "chats")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([...ids].sort());
    expect((await zipEntryNames("e1")).filter((name) => name.startsWith("chats/"))).toHaveLength(
      101,
    );
    // No chat is loaded twice, and the counts add up.
    expect([...chatLoads].sort()).toEqual([...ids].sort());
    expect(posted.filter((m) => m.type === "batchComplete").map((m) => m.batchNumber)).toEqual([
      1, 2,
    ]);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "complete", processed: 101, skipped: 0, batches: 2 }),
    );
  });

  it("counts a chat that is missing or fails to stage as skipped, once", async () => {
    await loadWorker();
    const ids = seedChats(6);
    chatRows.set("c2", undefined as unknown as Chat); // in the batch, but not in the database
    opfs.onWrite = (path) => {
      if (path.endsWith("/c3.json")) throw new Error("disk full");
    };
    onChatLoad = async (id) => {
      if (id === "c0") await send({ type: "pause" });
    };

    await send(startMessage("r1", "e1", ids));
    onChatLoad = undefined;
    posted = [];
    await send({ type: "resume" });

    expect([...chatLoads].sort()).toEqual([...ids].sort());
    expect(stagedChatIds("e1").sort()).toEqual(["c0", "c1", "c4", "c5"]);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "complete", processed: 4, skipped: 2, batches: 1 }),
    );
  });

  it("finishes the chat it is on, attachments included, before it pauses", async () => {
    await loadWorker();
    const ids = seedChats(3, { c0: 3 });
    // The pause lands while the first attachment of the first chat is being written.
    let paused = false;
    opfs.onWrite = async (path) => {
      if (!paused && path.includes("/media/c0/")) {
        paused = true;
        await send({ type: "pause" });
      }
    };

    await send(startMessage("r1", "e1", ids));
    expect(stagedChatIds("e1")).toEqual(["c0"]);
    expect(manifestLines("e1", "media")).toHaveLength(3);

    await send({ type: "resume" });
    expect(stagedChatIds("e1").sort()).toEqual(["c0", "c1", "c2"]);
    expect(manifestLines("e1", "media").map((entry) => entry.chatId)).toEqual(["c0", "c0", "c0"]);
    expect((await zipEntryNames("e1")).filter((name) => name.startsWith("media/"))).toHaveLength(3);
  });
});

// ---- HVN-61: a cancel and a resume ------------------------------------------------------------

/** A promise a test settles by hand, to hold a chat load until it says so. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe("a cancel mid-batch and a start after it (HVN-61)", () => {
  it("ends the cancelled job quietly and leaves the next job its own counters", async () => {
    await loadWorker();
    const first = seedChats(101);
    const second = seedChats(3, {}, "d");
    const heldFirst = gate();
    const heldSecond = gate();
    onChatLoad = async (id) => {
      if (id === "c0") await heldFirst.wait;
      if (id === "d0") await heldSecond.wait;
    };

    const firstRun = send(startMessage("r1", "e1", first));
    await vi.waitFor(() => expect(chatLoads).toContain("c0"));
    await send({ type: "cancel" });
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled" }));

    // A start is accepted after the cancel, and is mid-chat when the cancelled batch wakes.
    const secondRun = send(startMessage("r2", "e2", second));
    await vi.waitFor(() => expect(chatLoads).toContain("d0"));
    heldFirst.open();
    await firstRun;

    // The cancelled job's batch has ended; it posted nothing after `cancelled`, and it did
    // not take the second job's chats.
    const afterCancel = posted.slice(posted.findIndex((m) => m.type === "cancelled") + 1);
    expect(afterCancel.filter((m) => m.requestId === "r1")).toEqual([]);
    expect(chatLoads.filter((id) => id.startsWith("d"))).toEqual(["d0"]);

    heldSecond.open();
    await secondRun;
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "complete",
        requestId: "r2",
        processed: 3,
        skipped: 0,
        batches: 1,
      }),
    );
    expect(stagedChatIds("e2").sort()).toEqual(["d0", "d1", "d2"]);
  });

  it("leaves the next job alone when a cancelled job wakes between batches", async () => {
    await loadWorker();
    const first = seedChats(101);
    const second = seedChats(3, {}, "d");
    // The cancel and a new start land right after the first batch, while the cancelled job
    // waits on the event loop. Its next call must not pick up the new job's state.
    workerSelf.postMessage = (message) => {
      posted.push(message);
      if (message.type === "progress" && String(message.status).startsWith("Completed batch 1/2")) {
        void send({ type: "cancel" });
        void send(startMessage("r2", "e2", second));
      }
    };

    await send(startMessage("r1", "e1", first));
    await vi.waitFor(() =>
      expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" })),
    );

    expect(chatLoads.filter((id) => id.startsWith("d"))).toEqual(["d0", "d1", "d2"]);
    expect(posted.filter((m) => m.type === "error")).toEqual([]);
    expect(posted.filter((m) => m.requestId === "r1" && m.type === "complete")).toEqual([]);
  });

  it("does not report a failure in a cancelled job's batch, nor end the next job", async () => {
    await loadWorker();
    const first = seedChats(101);
    const second = seedChats(3, {}, "d");
    const heldFirst = gate();
    const heldSecond = gate();
    onChatLoad = async (id) => {
      if (id === "c0") {
        await heldFirst.wait;
        throw new Error("db closed");
      }
      if (id === "d0") await heldSecond.wait;
    };

    const firstRun = send(startMessage("r1", "e1", first));
    await vi.waitFor(() => expect(chatLoads).toContain("c0"));
    await send({ type: "cancel" });
    const secondRun = send(startMessage("r2", "e2", second));
    await vi.waitFor(() => expect(chatLoads).toContain("d0"));

    heldFirst.open();
    await firstRun;
    expect(posted.filter((m) => m.type === "error")).toEqual([]);

    heldSecond.open();
    await secondRun;
    expect(posted).toContainEqual(
      expect.objectContaining({ type: "complete", requestId: "r2", processed: 3 }),
    );
  });

  // The cancel lands at each step of the finalizing, after the last batch: the job stops
  // before the next step, so a cancelled export does not zip its whole staging tree.
  it.each([
    ["writes the manifest meta", "/meta.json", false, false],
    ["writes the manifest", "/staging/manifest.json", true, false],
    ["builds the ZIP", buildExportZipPath("e1"), true, true],
  ])("stops a job cancelled while it %s", async (_step, pathEnd, manifestWritten, zipBuilt) => {
    await loadWorker();
    const ids = seedChats(2);
    opfs.onWrite = async (path) => {
      if (path.endsWith(pathEnd)) await send({ type: "cancel" });
    };

    await send(startMessage("r1", "e1", ids));

    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled" }));
    expect(posted.filter((m) => m.type === "error" || m.type === "complete")).toEqual([]);
    expect(opfs.files.has("exports/e1/staging/manifest.json")).toBe(manifestWritten);
    expect(opfs.files.has(buildExportZipPath("e1"))).toBe(zipBuilt);
  });
});

describe("what the job posts reaches the start's listener (HVN-61)", () => {
  it("answers a cancel while paused on the requestId of the start", async () => {
    await loadWorker();
    const ids = seedChats(3);
    onChatLoad = async (id) => {
      if (id === "c0") await send({ type: "pause" });
    };
    await send(startMessage("r1", "e1", ids));
    expect(posted).toContainEqual(expect.objectContaining({ type: "paused", requestId: "r1" }));

    posted = [];
    // The service worker sends a cancel with no requestId of its own.
    await send({ type: "cancel" });
    expect(posted).toEqual([{ type: "cancelled", requestId: "r1" }]);
  });

  it("carries the start's requestId on everything a resumed job posts", async () => {
    await loadWorker();
    const ids = seedChats(101);
    onChatLoad = async (id) => {
      if (id === "c0") await send({ type: "pause" });
    };
    await send(startMessage("r1", "e1", ids));
    onChatLoad = undefined;
    posted = [];

    // The service worker sends a resume with no requestId of its own.
    await send({ type: "resume" });

    const announced = posted.filter(
      (m) => m.type !== "progress" || String(m.status).startsWith("Processing batch"),
    );
    expect(announced.map((m) => m.type)).toContain("complete");
    expect(announced.filter((m) => m.requestId !== "r1")).toEqual([]);
  });
});
