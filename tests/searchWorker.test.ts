import "fake-indexeddb/auto";
import lunr from "lunr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, SearchResult } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";

// A heavy file: every test re-imports the worker and most run full index rebuilds, so the 5 s
// default fails it on a loaded machine while it passes alone (HVN-70). The other files keep it.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// SearchIndexManager reaches the worker through the offscreen document; these tests give it the
// worker itself, so an add is the message the manager really sends (HVN-76).
const toWorker = vi.hoisted(() => ({
  send: undefined as undefined | ((message: unknown) => Promise<void>),
}));
vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: async (_worker: string, message: unknown) => {
    await toWorker.send?.(message);
    return undefined;
  },
}));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: async () => undefined,
}));

// The worker opens its own database; keep each one so a test can make its writes fail.
const workerDbs = vi.hoisted(
  () =>
    [] as Array<{
      lunrIndex: { put: (...a: unknown[]) => unknown };
      chats: { offset: (n: number) => unknown };
    }>,
);
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

// The worker talks through `self`; stand one in, import the module (which installs
// `self.onmessage`), and drive it with the messages the offscreen document would send.
type Posted = { type: string; requestId?: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
let workerSelf: WorkerGlobal;

async function loadWorker(): Promise<void> {
  vi.resetModules();
  posted = [];
  workerSelf = { postMessage: (message) => posted.push(message) };
  vi.stubGlobal("self", workerSelf);
  await import("../src/services/search.worker");
  toWorker.send = (message) => send(message as Record<string, unknown>);
}

function send(message: Record<string, unknown>): Promise<void> {
  if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
  return workerSelf.onmessage({ data: message });
}

let requestCounter = 0;

/** Run a search through the worker and return what it posted for it, in order. */
async function search(query: string, hydrate: boolean): Promise<Posted[]> {
  const requestId = `test-${++requestCounter}`;
  await send({ type: "search", query, requestId, hydrate });
  return posted.filter((m) => m.type === "searchResultChunk" && m.requestId === requestId);
}

function hitIds(chunks: Posted[]): string[] {
  const ids: string[] = [];
  for (const chunk of chunks) {
    for (const r of chunk.results as Array<string | SearchResult>) {
      ids.push(typeof r === "string" ? r : r.chatId);
    }
  }
  return ids;
}

function buildChat(id: string, text: string): Chat {
  const message: ChatMessage = {
    id: `${id}-m1`,
    childrenIds: [],
    chatId: id,
    model: "test-model",
    done: true,
    timestamp: 1704067200000,
    message: [
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: text, timestamp: "2024-01-01T00:00:00Z" }],
      },
      {
        kind: "response",
        parts: [{ part_kind: "text", content: `answer to ${text}` }],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ],
  };
  return {
    id,
    source: "test",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["test-model"],
    system: undefined,
    params: {},
    currentId: message.id,
    messages: { [message.id]: message },
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "synced",
    lastSyncAttemptMessage: undefined,
    deleted: 0,
  };
}

async function seedChats(chats: Chat[]): Promise<void> {
  await getDB().chats.bulkPut(chats);
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.chatMessages.clear(), db.lunrIndex.clear()]);
  await loadWorker();
});

describe("search worker: a search during an index rebuild", () => {
  it("reports the rebuild, with progress, instead of an empty result", async () => {
    // More chats than one fetch (50) so that the rebuild takes several reads.
    await seedChats(
      Array.from({ length: 120 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
    );

    let finished = false;
    const rebuild = send({ type: "rebuild" }).then(() => {
      finished = true;
    });

    // The rebuild marks itself before its first await, so this search is mid-rebuild.
    const during = await search("pineapple", true);
    expect(during).toHaveLength(1);
    expect(during[0]).toMatchObject({ results: [], done: true });
    expect(during[0].indexRebuilding).toEqual({
      processed: expect.any(Number),
      total: expect.any(Number),
      percentage: expect.any(Number),
    });

    // Keep asking until it ends: every answer is the status, never a bare empty list, and
    // the progress it reports does not go backwards.
    const percentages: number[] = [];
    let lastTotal = 0;
    while (!finished) {
      await new Promise((r) => setTimeout(r, 0));
      if (finished) break;
      const [chunk] = await search("pineapple", true);
      const status = chunk.indexRebuilding as
        | { processed: number; total: number; percentage: number }
        | undefined;
      if (status) {
        percentages.push(status.percentage);
        lastTotal = status.total;
        expect(chunk.results).toEqual([]);
      } else {
        // The rebuild ended between the check and the search: a real answer.
        expect(hitIds([chunk]).length).toBeGreaterThan(0);
      }
    }
    await rebuild;

    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(lastTotal === 0 || lastTotal === 120).toBe(true);

    // Once it ends, the same search finds the chats and carries no status.
    const after = await search("pineapple", true);
    expect(after.every((c) => c.indexRebuilding === undefined)).toBe(true);
    expect(new Set(hitIds(after)).size).toBe(120);
  });

  it("reports the rebuild for an id-only search too", async () => {
    await seedChats([buildChat("c1", "pineapple")]);
    const rebuild = send({ type: "rebuild" });

    const [during] = await search("pineapple", false);
    expect(during.results).toEqual([]);
    expect(during.indexRebuilding).toBeDefined();

    await rebuild;
    expect(hitIds(await search("pineapple", false))).toEqual(["c1"]);
  });

  it("does not report a rebuild for a search with no matches once the index is ready", async () => {
    await seedChats([buildChat("c1", "pineapple")]);
    await send({ type: "rebuild" });

    const chunks = await search("zeppelin", true);
    expect(hitIds(chunks)).toEqual([]);
    expect(chunks.every((c) => c.indexRebuilding === undefined)).toBe(true);
  });

  it("reports progress as chats are read, not only per 1000", async () => {
    await seedChats(
      Array.from({ length: 120 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
    );
    let finished = false;
    const rebuild = send({ type: "rebuild" }).then(() => {
      finished = true;
    });

    const processedSeen = new Set<number>();
    while (!finished) {
      await new Promise((r) => setTimeout(r, 0));
      const [chunk] = await search("pineapple", true);
      const status = chunk?.indexRebuilding as { processed: number } | undefined;
      if (status) processedSeen.add(status.processed);
    }
    await rebuild;

    // 120 chats fit in one 1000-chat chunk, so only a per-read counter is ever
    // seen strictly between the ends; a per-chunk counter jumps from 0 to 120.
    expect([...processedSeen].some((n) => n > 0 && n < 120)).toBe(true);
  });
});

describe("search worker: soft-deleted chats", () => {
  async function softDelete(id: string): Promise<void> {
    await getDB().chats.update(id, { deleted: 1, deletedAt: Date.now() });
  }

  async function indexTwoPineappleChats(): Promise<void> {
    await seedChats([buildChat("keep", "pineapple"), buildChat("gone", "pineapple")]);
    await send({ type: "rebuild" });
  }

  it("leaves a soft-deleted chat out of id-only results", async () => {
    await indexTwoPineappleChats();
    expect(hitIds(await search("pineapple", false)).sort()).toEqual(["gone", "keep"]);

    await softDelete("gone");

    expect(hitIds(await search("pineapple", false))).toEqual(["keep"]);
  });

  it("leaves a soft-deleted chat out of hydrated results", async () => {
    await indexTwoPineappleChats();
    await softDelete("gone");

    const chatIds = new Set(hitIds(await search("pineapple", true)));

    expect([...chatIds]).toEqual(["keep"]);
  });

  it("finds the chat again once it is no longer deleted (a re-sync restores it)", async () => {
    await indexTwoPineappleChats();
    await softDelete("gone");
    await getDB().chats.update("gone", { deleted: 0, deletedAt: undefined });

    expect(hitIds(await search("pineapple", false)).sort()).toEqual(["gone", "keep"]);
  });

  it("is not fooled by a delete that happened after the index was written to storage", async () => {
    await indexTwoPineappleChats();
    await softDelete("gone");

    // A fresh worker (the offscreen document restarted) loads the persisted segments, which
    // still hold the deleted chat.
    await loadWorker();
    await send({ type: "init" });

    expect(hitIds(await search("pineapple", false))).toEqual(["keep"]);
  });
});

type RebuildStatus = { processed: number; total: number; percentage: number };

/** Run the clock and the event loop until `done` settles (fake timers, real IndexedDB). */
async function settle(done: Promise<unknown>): Promise<void> {
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  while (!finished) {
    await vi.advanceTimersByTimeAsync(10);
    await new Promise((r) => setImmediate(r));
  }
}

/** Poll with searches until the worker answers without a rebuild status. */
async function waitUntilIndexReady(query = "pineapple"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const [chunk] = await search(query, false);
    if (chunk.indexRebuilding === undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the index never became ready");
}

describe("search worker: a rebuild that fails (HVN-50)", () => {
  /**
   * 200 good chats fill segment_0 (it is built and stored), then the rebuild reads "zzz-bad",
   * whose message list cannot be read, and fails with the index part-built.
   */
  async function seedOneUnreadableChat(): Promise<void> {
    const bad = buildChat("zzz-bad", "pineapple");
    const message = bad.messages["zzz-bad-m1"];
    (message as { message: unknown }).message = 42;
    await seedChats([
      ...Array.from({ length: 200 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
      bad,
    ]);
  }

  function lastBulkComplete(): Posted {
    const replies = posted.filter((m) => m.type === "bulkComplete");
    return replies[replies.length - 1];
  }

  it("replies that it failed, and says why", async () => {
    await seedOneUnreadableChat();

    await send({ type: "rebuild" });

    const reply = lastBulkComplete();
    expect(reply.success).toBe(false);
    expect(typeof reply.error).toBe("string");
    expect((reply.error as string).length).toBeGreaterThan(0);
    expect(posted.some((m) => m.type === "indexRebuildComplete")).toBe(false);
  });

  it("marks a search that finds nothing, so an empty answer is not read as no matches", async () => {
    await seedOneUnreadableChat();
    await send({ type: "rebuild" });

    const [chunk] = await search("zeppelin", true);

    expect(chunk).toMatchObject({ results: [], done: true });
    expect(chunk.indexRebuilding).toBeUndefined();
    expect(chunk.indexIncomplete).toEqual({ error: lastBulkComplete().error });
  });

  it("marks a search that finds chats, on its last chunk, for id-only and hydrated searches", async () => {
    await seedOneUnreadableChat();
    await send({ type: "rebuild" });

    for (const hydrate of [false, true]) {
      const chunks = await search("pineapple", hydrate);

      expect(hitIds(chunks).length).toBeGreaterThan(0);
      const marked = chunks.filter((c) => c.indexIncomplete !== undefined);
      expect(marked).toHaveLength(1);
      expect(marked[0]).toBe(chunks[chunks.length - 1]);
      expect(marked[0].done).toBe(true);
    }
  });

  it("does not mark searches before any rebuild has failed", async () => {
    await seedChats([buildChat("c1", "pineapple")]);
    await send({ type: "rebuild" });

    const chunks = await search("pineapple", true);

    expect(lastBulkComplete().success).toBe(true);
    expect(chunks.every((c) => c.indexIncomplete === undefined)).toBe(true);
  });

  it("recovers on the next explicit rebuild", async () => {
    await seedOneUnreadableChat();
    await send({ type: "rebuild" });
    await getDB().chats.delete("zzz-bad");

    await send({ type: "rebuild" });

    expect(lastBulkComplete().success).toBe(true);
    const chunks = await search("pineapple", false);
    expect(chunks.every((c) => c.indexIncomplete === undefined)).toBe(true);
    expect(new Set(hitIds(chunks)).size).toBe(200);
  });

  it("recovers on the next init, even when the stored segments already hold every chat", async () => {
    await seedOneUnreadableChat();
    await send({ type: "rebuild" });
    // segment_0 (200 chats) is stored: once the bad chat is gone, a count of chats against
    // indexed documents sees nothing wrong, so only the failure itself can start the rebuild.
    await getDB().chats.delete("zzz-bad");

    await send({ type: "init" });
    await waitUntilIndexReady();

    const chunks = await search("pineapple", false);
    expect(chunks.every((c) => c.indexIncomplete === undefined)).toBe(true);
    expect(new Set(hitIds(chunks)).size).toBe(200);
  });
});

describe("search worker: init and the rebuild it starts (HVN-50)", () => {
  it("answers init only after the consistency check, so the next search is told about the rebuild", async () => {
    await seedChats([buildChat("c1", "pineapple"), buildChat("c2", "pineapple")]);

    await send({ type: "init" });
    const [chunk] = await search("pineapple", false);

    expect(chunk.results).toEqual([]);
    expect(chunk.indexRebuilding as RebuildStatus | undefined).toBeDefined();
    await waitUntilIndexReady();
    expect(new Set(hitIds(await search("pineapple", false)))).toEqual(new Set(["c1", "c2"]));
  });
});

describe("search worker: timers and a second request around a rebuild (HVN-50)", () => {
  const staleId = "stale";

  it("drops the debounce timer of an earlier add when a rebuild starts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await seedChats([
        buildChat("c1", "pineapple"),
        buildChat("c2", "pineapple"),
        buildChat(staleId, "pineapple"),
      ]);
      await send({ type: "add", chatId: staleId });
      await getDB().chats.delete(staleId); // gone by the time the rebuild reads
      expect(vi.getTimerCount()).toBe(1);

      const rebuild = send({ type: "rebuild" });
      expect(vi.getTimerCount()).toBe(0);
      await settle(rebuild);
      await vi.advanceTimersByTimeAsync(5000);

      // The old segment object must not be written over the new one with its old document list.
      const stored = await getDB().lunrIndex.get("segment_0");
      expect([...((stored?.meta as { docIds: string[] }).docIds ?? [])].sort()).toEqual([
        "c1",
        "c2",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules no debounced rebuild for an add that arrives during a rebuild", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await seedChats([buildChat("c1", "pineapple")]);

      const rebuild = send({ type: "rebuild" });
      await send({ type: "add", chatId: staleId });
      expect(vi.getTimerCount()).toBe(0);

      await settle(rebuild);
    } finally {
      vi.useRealTimers();
    }
  });

  it("still debounces an add when no rebuild is running", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await seedChats([buildChat(staleId, "pineapple")]);
      await send({ type: "add", chatId: staleId });
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("indexes a chat written after a running rebuild counted the chats, when a second rebuild is asked for", async () => {
    await seedChats(
      Array.from({ length: 600 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
    );
    const first = send({ type: "rebuild" });

    // Wait until the first rebuild has counted (its status carries the total).
    let status: RebuildStatus | undefined;
    while (!status || status.total === 0) {
      await new Promise((r) => setTimeout(r, 0));
      const [chunk] = await search("pineapple", false);
      status = chunk.indexRebuilding as RebuildStatus | undefined;
      if (!status) throw new Error("the first rebuild ended before the test could write");
    }
    await seedChats([buildChat("zzz-late", "pineapple")]);
    const [still] = await search("pineapple", false);
    // The write above must have landed inside the running rebuild, or this proves nothing.
    expect(still.indexRebuilding).toBeDefined();

    const second = send({ type: "rebuild" });
    await Promise.all([first, second]);

    expect(hitIds(await search("pineapple", false))).toContain("zzz-late");
    const replies = posted.filter((m) => m.type === "bulkComplete");
    expect(replies).toHaveLength(2);
    expect(replies.every((r) => r.success === true)).toBe(true);
  });
});

describe("search worker: init, restarts and a failure that stays (HVN-50, round 2)", () => {
  async function seedGoodChats(count: number, text: string): Promise<void> {
    await seedChats(
      Array.from({ length: count }, (_, i) => buildChat(`c${String(i).padStart(3, "0")}`, text)),
    );
  }

  function unreadable(id: string, text: string): Chat {
    const bad = buildChat(id, text);
    (bad.messages[`${id}-m1`] as { message: unknown }).message = 42;
    return bad;
  }

  /** A status check that does not disturb the worker: is a rebuild running right now? */
  async function statusNow(query = "pineapple"): Promise<Posted> {
    const chunks = await search(query, false);
    return chunks[chunks.length - 1];
  }

  it("does not start another pass when init arrives while a rebuild runs", async () => {
    await seedGoodChats(300, "pineapple");
    const rebuild = send({ type: "rebuild" });
    for (;;) {
      await new Promise((r) => setTimeout(r, 0));
      const status = (await statusNow()).indexRebuilding as RebuildStatus | undefined;
      if (!status) throw new Error("the rebuild ended before init could be sent");
      if (status.total > 0) break;
    }

    await send({ type: "init" }); // a service worker woke and asked
    await rebuild;

    expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(1);
    expect(new Set(hitIds(await search("pineapple", false))).size).toBe(300);
  });

  it("retries a failed rebuild on init once, then leaves it until the worker restarts", async () => {
    await seedGoodChats(200, "pineapple");
    await seedChats([unreadable("zzz-bad", "pineapple")]);
    await send({ type: "rebuild" }); // fails; failure is on record

    await send({ type: "init" });
    expect((await statusNow()).indexRebuilding).toBeDefined(); // the one retry is running
    await waitUntilIndexReady();
    expect((await statusNow()).indexIncomplete).toBeDefined(); // and it failed again

    await send({ type: "init" });
    const after = await statusNow();
    expect(after.indexRebuilding).toBeUndefined(); // no third read of the archive
    expect(after.indexIncomplete).toBeDefined();

    // An explicit rebuild is still honoured.
    await getDB().chats.delete("zzz-bad");
    await send({ type: "rebuild" });
    expect(lastReply().success).toBe(true);
    expect((await statusNow()).indexIncomplete).toBeUndefined();
  });

  it("gives a later failure its own retry once a rebuild has succeeded", async () => {
    await seedGoodChats(200, "pineapple");
    await seedChats([unreadable("zzz-bad", "pineapple")]);
    await send({ type: "rebuild" });
    await getDB().chats.delete("zzz-bad");
    await send({ type: "init" }); // the retry, and it succeeds
    await waitUntilIndexReady();
    expect((await statusNow()).indexIncomplete).toBeUndefined();

    await seedChats([unreadable("zzz-bad", "pineapple")]);
    await send({ type: "rebuild" }); // fails again
    await send({ type: "init" });

    expect((await statusNow()).indexRebuilding).toBeDefined();
    await waitUntilIndexReady();
  });

  it("rebuilds after a worker restart that follows a failed rebuild, instead of trusting the old segments", async () => {
    await seedGoodChats(400, "pineapple");
    await send({ type: "rebuild" }); // a whole index of the old text, in two stored segments
    await seedGoodChats(399, "mango"); // every chat but the last changes
    await seedChats([unreadable("c399", "mango")]);
    await send({ type: "rebuild" });
    expect(lastReply().success).toBe(false);
    await seedChats([buildChat("c399", "mango")]); // repaired

    await loadWorker(); // the offscreen document went away and came back
    await send({ type: "init" });
    await waitUntilIndexReady("mango");

    const chunks = await search("mango", false);
    expect(chunks.every((c) => c.indexIncomplete === undefined)).toBe(true);
    expect(new Set(hitIds(chunks)).size).toBe(400);
    expect(hitIds(await search("pineapple", false))).toEqual([]);
  });

  it("counts a failed write of a segment as a failed rebuild", async () => {
    await seedGoodChats(205, "pineapple");
    const db = workerDbs[workerDbs.length - 1];
    vi.spyOn(db.lunrIndex, "put").mockRejectedValue(new Error("QuotaExceededError"));

    await send({ type: "rebuild" });

    const reply = lastReply();
    expect(reply.success).toBe(false);
    expect(reply.error).toContain("QuotaExceededError");
    const chunks = await search("pineapple", false);
    expect(chunks[chunks.length - 1].indexIncomplete).toEqual({ error: reply.error });
  });
});

function lastReply(): Posted {
  const replies = posted.filter((m) => m.type === "bulkComplete");
  return replies[replies.length - 1];
}

describe("search worker: an add or a remove during an index rebuild (HVN-54)", () => {
  /** A held step: `paused` settles when it is reached, `resume` lets it go on. */
  type Hold = {
    paused: Promise<void>;
    resume: () => void;
    reached: () => void;
    released: Promise<void>;
  };

  function newHold(): Hold {
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((r) => {
      reached = r;
    });
    const released = new Promise<void>((r) => {
      resume = r;
    });
    return { paused, resume, reached, released };
  }

  /**
   * Hold the running rebuild just before it reads the page of chats that follows the first
   * `chatsRead` of them (a multiple of the 50 it reads at a time): it has read, and moved past,
   * those. It counts the pages whichever way the rebuild asks for them (by position or by key),
   * so the same hold applies to the code before and after it paged by key.
   */
  function holdRebuildAfter(chatsRead: number): Hold {
    const db = workerDbs[workerDbs.length - 1];
    const hold = newHold();
    const holdPage = chatsRead / 50;
    let pages = 0;
    type Reads = { limit: (n: number) => Reads; toArray: () => Promise<unknown[]> };
    const counted = (reads: Reads): Reads => {
      const limit = reads.limit.bind(reads);
      reads.limit = (count: number) => {
        const limited = limit(count);
        const toArray = limited.toArray.bind(limited);
        limited.toArray = async () => {
          if (pages++ === holdPage) {
            hold.reached();
            await hold.released;
          }
          return toArray();
        };
        return limited;
      };
      return reads;
    };
    const table = db.chats as unknown as Record<string, (...args: unknown[]) => unknown>;
    const offset = table.offset.bind(table);
    const toCollection = table.toCollection.bind(table);
    const where = table.where.bind(table);
    vi.spyOn(table, "offset").mockImplementation(((n: number) =>
      counted(offset(n) as Reads)) as never);
    vi.spyOn(table, "toCollection").mockImplementation((() =>
      counted(toCollection() as Reads)) as never);
    vi.spyOn(table, "where").mockImplementation(((...args: unknown[]) => {
      const clause = where(...args) as { above: (key: unknown) => Reads };
      const above = clause.above.bind(clause);
      clause.above = (key: unknown) => counted(above(key));
      return clause;
    }) as never);
    return hold;
  }

  function chatIds(count: number): string[] {
    return Array.from({ length: count }, (_, i) => `c${String(i).padStart(3, "0")}`);
  }

  async function startHeldRebuild(
    count: number,
    holdBefore: number,
  ): Promise<{ rebuild: Promise<void>; hold: Hold }> {
    await seedChats(chatIds(count).map((id) => buildChat(id, "pineapple")));
    const hold = holdRebuildAfter(holdBefore);
    const rebuild = send({ type: "rebuild" });
    await hold.paused;
    return { rebuild, hold };
  }

  /** What a save does: write the row, then send the add. */
  async function rewriteAndAdd(id: string, text: string): Promise<void> {
    await seedChats([buildChat(id, text)]);
    await send({ type: "add", chatId: id });
  }

  it("indexes a chat written after the rebuild counted the chats", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("zzz-late", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["zzz-late"]);
    expect(hitIds(await search("pineapple", false))).toHaveLength(120);
  });

  it("indexes the new text of a chat the rebuild had read, in the segment it is filling", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["c000"]);
  });

  it("indexes the new text of a chat the rebuild had read, in a segment it had already written", async () => {
    const { rebuild, hold } = await startHeldRebuild(300, 250);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["c000"]);
  });

  it("writes the new text of a chat the rebuild had read to storage", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    // The segment the pass wrote holds the old text, and the debounce is off while it runs.
    await vi.waitFor(async () => {
      const stored = await getDB().lunrIndex.get("segment_0");
      expect(JSON.stringify(stored?.index)).toContain("mango");
    });
  });

  it("indexes an add that arrives while the rebuild is reading the earlier ones", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);
    const db = workerDbs[workerDbs.length - 1];
    const bulkGet = db.chats.bulkGet.bind(db.chats);
    const reading = newHold();
    let calls = 0;
    // The first bulkGet is the rebuild's own (its last segment); the second reads the adds.
    vi.spyOn(db.chats, "bulkGet").mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls !== 2) return bulkGet(...args);
      reading.reached();
      return reading.released.then(() => bulkGet(...args));
    }) as never);

    await rewriteAndAdd("early", "mango");
    hold.resume();
    await reading.paused;
    await rewriteAndAdd("late", "kiwi");
    reading.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["early"]);
    expect(hitIds(await search("kiwi", false))).toEqual(["late"]);
  });

  it("answers once, and runs one pass, for a rebuild that took an add", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("zzz-late", "mango");
    hold.resume();
    await rebuild;

    expect(posted.filter((m) => m.type === "bulkComplete")).toEqual([
      { type: "bulkComplete", success: true },
    ]);
    expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(1);
  });

  it("indexes the chat that follows a chat deleted behind the rebuild", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    // Paged by position, the rows after c000 would move up one place and c100 would be skipped.
    await getDB().chats.delete("c000");
    await send({ type: "removeMany", chatIds: ["c000"] });
    hold.resume();
    await rebuild;

    const found = hitIds(await search("pineapple", false));
    expect(
      chatIds(120)
        .slice(1)
        .filter((id) => !found.includes(id)),
    ).toEqual([]);
    expect(posted.filter((m) => m.type === "bulkComplete")).toEqual([
      { type: "bulkComplete", success: true },
    ]);
  });

  it("reads every chat when one is written behind the rebuild's place", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    // Sorts before c000: paged by position, the rows after it would move down and c119 would
    // never be reached.
    await rewriteAndAdd("a-new", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["a-new"]);
    expect(hitIds(await search("pineapple", false)).sort()).toEqual(chatIds(120));
  });

  it("reads every chat when one is written ahead of the rebuild's place", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    // Between c105 and c106: the rebuild reads it, and still reaches the last chat.
    await rewriteAndAdd("c105a", "pineapple");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("pineapple", false)).sort()).toEqual(
      [...chatIds(120), "c105a"].sort(),
    );
  });

  it("indexes nothing for a chat that is gone by the time the rebuild reads its add", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("gone", "mango");
    await getDB().chats.delete("gone");
    await send({ type: "removeMany", chatIds: ["gone"] });
    hold.resume();
    await rebuild;

    expect(posted.filter((m) => m.type === "bulkComplete")).toEqual([
      { type: "bulkComplete", success: true },
    ]);
    expect(hitIds(await search("mango", false))).toEqual([]);
  });

  it("reports no progress, and no percentage that is not a number, for an archive with no chats", async () => {
    await send({ type: "rebuild" });

    expect(posted.filter((m) => m.type === "indexRebuildProgress")).toEqual([]);
    expect(lastReply()).toEqual({ type: "bulkComplete", success: true });
  });

  it("fails the rebuild when the segment it writes for the adds cannot be written", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);
    const db = workerDbs[workerDbs.length - 1];
    const put = db.lunrIndex.put.bind(db.lunrIndex);
    let writes = 0;
    // The first write is the rebuild's own last segment; the second is the one for the adds.
    vi.spyOn(db.lunrIndex, "put").mockImplementation(((...args: unknown[]) =>
      ++writes === 1 ? put(...args) : Promise.reject(new Error("QuotaExceededError"))) as never);

    await rewriteAndAdd("late", "mango");
    hold.resume();
    await rebuild;

    const reply = lastReply();
    expect(reply.success).toBe(false);
    expect(reply.error).toContain("QuotaExceededError");
    const chunks = await search("pineapple", false);
    expect(chunks[chunks.length - 1].indexIncomplete).toEqual({ error: reply.error });
  });
});

describe("search worker: snippets hold and mark the match (HVN-20)", () => {
  const filler = (n: number) => "lorem ipsum dolor ".repeat(Math.ceil(n / 18)).slice(0, n);
  const MARK = "{{HIGHLIGHT}}pineapple{{/HIGHLIGHT}}";

  /** One message with a prompt part and a reply part, as the transformers can produce. */
  function buildTurn(id: string, prompt: string, reply: string): Chat {
    const chat = buildChat(id, "unused");
    const message = chat.messages[`${id}-m1`];
    message.message = [
      { kind: "request", parts: [{ part_kind: "user-prompt", content: prompt, timestamp: "t" }] },
      { kind: "response", parts: [{ part_kind: "text", content: reply }], timestamp: "t" },
    ] as ChatMessage["message"];
    return chat;
  }

  async function indexTurn(id: string, prompt: string, reply: string): Promise<void> {
    await seedChats([buildTurn(id, prompt, reply)]);
    await send({ type: "rebuild" });
  }

  async function snippetsFor(query: string, contextChars?: number): Promise<SearchResult[]> {
    const requestId = `test-${++requestCounter}`;
    await send({ type: "search", query, requestId, hydrate: true, contextChars });
    return posted
      .filter((m) => m.type === "searchResultChunk" && m.requestId === requestId)
      .flatMap((m) => m.results as SearchResult[]);
  }

  it("holds a match that sits in the reply, far from the start of the prompt", async () => {
    await indexTurn("far", "a short question", `${filler(900)} pineapple ${filler(900)}`);

    const [result] = await snippetsFor("pineapple");

    expect(result.messageRole).toBe("assistant");
    expect(result.messageSnippet).toContain(MARK);
    expect(result.messageContent).toContain("pineapple");
  });

  it("marks every match in the window, not only the first", async () => {
    await indexTurn("many", "question", "pineapple on pineapple and more pineapple");

    const [result] = await snippetsFor("pineapple");

    expect(result.messageSnippet.split(MARK)).toHaveLength(4);
  });

  it("shows a second window when the next match is further away than the context", async () => {
    await indexTurn("two", "question", `pineapple ${filler(600)} pineapple`);

    const [result] = await snippetsFor("pineapple", 30);

    expect(result.messageSnippet.split(" ... ")).toHaveLength(2);
    expect(result.messageSnippet.split(MARK)).toHaveLength(3);
    expect(result.messageSnippet.length).toBeLessThan(200);
  });

  it("keeps the context window to the characters asked for", async () => {
    await indexTurn("ctx", "question", `${filler(300)} pineapple ${filler(300)}`);

    const [narrow] = await snippetsFor("pineapple", 10);
    const [wide] = await snippetsFor("pineapple", 100);

    const bare = (s: string) =>
      s
        .replace(/\{\{\/?HIGHLIGHT\}\}/g, "")
        .replace(/^\.\.\. /, "")
        .replace(/ \.\.\.$/, "");
    expect(bare(narrow.messageSnippet).length).toBeLessThanOrEqual(10 + "pineapple".length + 10);
    expect(bare(wide.messageSnippet).length).toBeGreaterThan(150);
  });

  // The index has no stemmer; a query with no exact hit is retried as a prefix (`run*`).
  it("marks the whole word a prefix match found, without the punctuation that came with it", async () => {
    await indexTurn("prefix", "question", `${filler(200)} we were running, late ${filler(200)}`);

    const [result] = await snippetsFor("run");

    expect(result.messageSnippet).toContain("{{HIGHLIGHT}}running{{/HIGHLIGHT}}, late");
  });

  // Lunr reports positions in the lower-cased text, where "İ" is two units (HVN-57).
  it("holds a match that follows text whose lower case is longer", async () => {
    await indexTurn("dotted", "question", `${"İ".repeat(80)} pineapple`);

    const [result] = await snippetsFor("pineapple");

    expect(result.messageRole).toBe("assistant");
    expect(result.messageSnippet).toContain(MARK);
  });

  it("marks the word, not its neighbours, when İ comes before it in the same message", async () => {
    await indexTurn(
      "dotted2",
      "question",
      `${"İ".repeat(30)} ${filler(40)} pineapple ${filler(80)}`,
    );

    const [result] = await snippetsFor("pineapple", 15);

    expect(result.messageSnippet).toContain(`${MARK} lorem`);
    expect(result.messageSnippet.split(MARK)).toHaveLength(2);
  });

  it("finds the right message when an earlier one has İ", async () => {
    const chat = buildTurn("dotted3", "question", "answer");
    const message = chat.messages["dotted3-m1"];
    message.message = [
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: "İ".repeat(60), timestamp: "t" }],
      },
      {
        kind: "response",
        parts: [{ part_kind: "text", content: "a pineapple here" }],
        timestamp: "t",
      },
    ] as ChatMessage["message"];
    await seedChats([chat]);
    await send({ type: "rebuild" });

    const results = await snippetsFor("pineapple");

    expect(results).toHaveLength(1);
    expect(results[0].messageRole).toBe("assistant");
    expect(results[0].messageSnippet).toContain(MARK);
  });

  it("holds and marks a match in multi-byte text", async () => {
    await indexTurn("cjk", "question", `${"字".repeat(300)} pineapple ${"字".repeat(300)}`);

    const [result] = await snippetsFor("pineapple", 20);

    expect(result.messageSnippet).toContain(MARK);
    expect(result.messageSnippet.length).toBeLessThan(100);
  });
});

describe("search worker: punctuation and scripts in the index (HVN-65)", () => {
  const MARK = (word: string) => `{{HIGHLIGHT}}${word}{{/HIGHLIGHT}}`;
  const marksOf = (snippet: string, word: string) => snippet.split(MARK(word)).length - 1;

  async function indexChats(...pairs: [string, string][]): Promise<void> {
    await seedChats(pairs.map(([id, text]) => buildChat(id, text)));
    await send({ type: "rebuild" });
  }

  async function hydrated(query: string): Promise<SearchResult[]> {
    const chunks = await search(query, true);
    return chunks.flatMap((c) => c.results as SearchResult[]);
  }

  async function ids(query: string): Promise<string[]> {
    return [...new Set(hitIds(await search(query, false)))].sort();
  }

  it("finds and marks every occurrence, whatever punctuation is stuck to it", async () => {
    const text =
      "one wombatz two wombatz, three wombatz. four wombatz; five (wombatz) six wombatz!";
    const occurrences = text.match(/wombatz/g)?.length;
    await indexChats(["c1", text]);

    for (const query of ["wombatz", "wombatz*"]) {
      const results = await hydrated(query);

      expect(results.length, query).toBeGreaterThan(0);
      for (const result of results) {
        expect(marksOf(result.messageSnippet, "wombatz"), query).toBe(occurrences);
      }
    }
  });

  it("finds a chat whose only occurrence has punctuation after it, by the exact word", async () => {
    await indexChats(
      ["comma", "I saw a wombat, then left"],
      ["plain", "a wombat sat down"],
      ["longer", "wombatic things happen"],
    );

    // The prefix fallback runs only when the exact search finds nothing, and `plain` is found
    // exactly, so `comma` has to be found exactly too; `longer` is a different word.
    expect(await ids("wombat")).toEqual(["comma", "plain"]);
    expect([...new Set((await hydrated("wombat")).map((r) => r.chatId))].sort()).toEqual([
      "comma",
      "plain",
    ]);
  });

  it("finds a word too short for the prefix fallback", async () => {
    await indexChats(["short", "the ox, the cow"]);

    expect(await ids("ox")).toEqual(["short"]);
  });

  it("finds the word when the search is typed with punctuation too", async () => {
    await indexChats(["comma", "I saw a wombat, then left"], ["plain", "a wombat sat down"]);

    expect(await ids("wombat,")).toEqual(["comma", "plain"]);
  });

  it("finds the chats that have the word bare when the search is typed with punctuation, hydrated too (HVN-71)", async () => {
    await indexChats(["comma", "I saw a wombat, then left"], ["plain", "a wombat sat down"]);

    expect([...new Set((await hydrated("wombat,")).map((r) => r.chatId))].sort()).toEqual([
      "comma",
      "plain",
    ]);
    const plain = (await hydrated("(wombat),")).find((r) => r.chatId === "plain");
    expect(marksOf(plain?.messageSnippet ?? "", "wombat")).toBe(1);
  });

  it("falls back to the prefix of a word typed with punctuation after it (HVN-71)", async () => {
    await indexChats(["run", "we were running late"], ["other", "a wombat sat down"]);

    expect(await ids("runn,")).toEqual(["run"]);
    expect((await hydrated("runn,")).map((r) => r.chatId)).toEqual(["run"]);
  });

  it("finds a quoted phrase that has punctuation after it", async () => {
    await indexChats(["p", "say hello world, please"], ["q", "hello there world"]);

    expect(await ids('"hello world"')).toEqual(["p"]);
    const [result] = await hydrated('"hello world"');
    expect(result.chatId).toBe("p");
    expect(marksOf(result.messageSnippet, "hello")).toBe(1);
    expect(marksOf(result.messageSnippet, "world")).toBe(1);
  });

  describe("in other scripts", () => {
    // Each script has a chat that has the word bare and one that has it with punctuation stuck to
    // it, so that finding both takes an exact match on the trimmed word, not a prefix fallback.
    const scripts: Array<[string, string, string, string]> = [
      ["Cyrillic", "привет", "привет мир", "сказал привет, мир!"],
      ["Greek", "καλημέρα", "καλημέρα κόσμε", "είπε καλημέρα, κόσμε!"],
      ["CJK", "你好世界", "你好世界 再见", "他说 你好世界。 再见"],
    ];

    for (const [script, word, bare, punctuated] of scripts) {
      it(`finds and marks ${script} with or without punctuation after it`, async () => {
        await indexChats(["bare", bare], ["punct", punctuated]);

        expect(await ids(word)).toEqual(["bare", "punct"]);
        const results = await hydrated(word);
        expect(new Set(results.map((r) => r.chatId))).toEqual(new Set(["bare", "punct"]));
        for (const result of results) {
          expect(marksOf(result.messageSnippet, word), result.messageSnippet).toBeGreaterThan(0);
        }
      });
    }

    it("does not let one script's words stand in for another's", async () => {
      await indexChats(
        ["ru", "привет, мир!"],
        ["el", "καλημέρα, κόσμε!"],
        ["zh", "你好世界。"],
        ["en", "hello, world!"],
      );

      expect(await ids("привет")).toEqual(["ru"]);
      expect(await ids("καλημέρα")).toEqual(["el"]);
      expect(await ids("你好世界")).toEqual(["zh"]);
      expect(await ids("hello")).toEqual(["en"]);
    });

    it("finds an emoji that has a comma after it", async () => {
      await indexChats(["e", "great 😀, thanks"], ["f", "great 😀 thanks"]);

      expect(await ids("😀")).toEqual(["e", "f"]);
    });
  });
});

describe("search worker: the index format version (HVN-65)", () => {
  /** What the index of the last release held: terms with their punctuation, no pipeline. */
  async function storeOldIndex(chats: Chat[]): Promise<void> {
    const builder = new lunr.Builder();
    builder.ref("id");
    builder.field("title", { boost: 10 });
    builder.field("content");
    builder.metadataWhitelist = ["position"];
    for (const chat of chats) {
      const message = chat.messages[`${chat.id}-m1`];
      const text = (message.message[0].parts[0] as { content: string }).content;
      builder.add({ id: chat.id as string, title: chat.title, content: text });
    }
    await getDB().lunrIndex.put({
      id: "segment_0",
      index: builder.build().toJSON(),
      meta: { docIds: chats.map((c) => c.id as string), timestamp: Date.now() },
    });
  }

  const rebuilds = () => posted.filter((m) => m.type === "indexRebuildComplete").length;

  async function restart(): Promise<void> {
    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
  }

  async function seedOldArchive(): Promise<void> {
    const chats = [buildChat("comma", "I saw a wombat, then left"), buildChat("plain", "a wombat")];
    await seedChats(chats);
    await storeOldIndex(chats);
  }

  async function lastIndexIncomplete(): Promise<unknown> {
    const chunks = await search("wombat", false);
    return chunks[chunks.length - 1].indexIncomplete;
  }

  it("rebuilds an index that has no version once, and not again at the starts after", async () => {
    await seedOldArchive();

    await restart();
    expect(rebuilds()).toBe(1);
    expect(new Set(hitIds(await search("wombat", false)))).toEqual(new Set(["comma", "plain"]));

    await restart();
    expect(rebuilds()).toBe(0);
    await restart();
    expect(rebuilds()).toBe(0);
    expect(new Set(hitIds(await search("wombat", false)))).toEqual(new Set(["comma", "plain"]));
  });

  it("does not load the stored segments of another version, which the rebuild discards (HVN-71)", async () => {
    await seedOldArchive();
    const load = vi.spyOn(lunr.Index, "load");
    await loadWorker();

    await send({ type: "init" });
    await waitUntilIndexReady("wombat");

    expect(rebuilds()).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect(new Set(hitIds(await search("wombat", false)))).toEqual(new Set(["comma", "plain"]));

    // The control: a start on the index that rebuild wrote does load it.
    await restart();
    expect(rebuilds()).toBe(0);
    expect(load).toHaveBeenCalled();
  });

  it("tells a search that comes right after the start that the index is rebuilding", async () => {
    await seedOldArchive();
    await loadWorker();

    await send({ type: "init" });
    const [chunk] = await search("wombat", false);

    expect(chunk.results).toEqual([]);
    expect(chunk.indexRebuilding).toBeDefined();
    await waitUntilIndexReady("wombat");
  });

  it("rebuilds an index of a version it does not know, as a downgrade would meet", async () => {
    await seedOldArchive();
    await getDB().lunrIndex.put({ id: "format", format: 99 });

    await restart();

    expect(rebuilds()).toBe(1);
    expect((await getDB().lunrIndex.get("format"))?.format).toBeLessThan(99);
  });

  it("rebuilds nothing, and records the version, for an archive that has no index yet", async () => {
    await loadWorker();
    await send({ type: "init" });

    expect(rebuilds()).toBe(0);
    expect(await getDB().lunrIndex.get("format")).toMatchObject({ format: expect.any(Number) });

    // The chats that arrive later are indexed into the current format, so the next start has
    // nothing to rebuild.
    await seedChats([buildChat("late", "a wombat")]);
    await send({ type: "add", chatId: "late" });
    await send({ type: "endBulk" });
    await restart();
    expect(rebuilds()).toBe(0);
  });

  it("records the version when a rebuild ends well, and not when it fails", async () => {
    await seedChats([buildChat("c1", "a wombat")]);
    await send({ type: "rebuild" });
    expect(await getDB().lunrIndex.get("format")).toBeDefined();

    const bad = buildChat("zzz-bad", "a wombat");
    (bad.messages["zzz-bad-m1"] as { message: unknown }).message = 42;
    await seedChats([bad]);
    await send({ type: "rebuild" });

    expect(lastReply().success).toBe(false);
    expect(await getDB().lunrIndex.get("format")).toBeUndefined();
  });

  it("does not rebuild in a loop when the rebuild of an old index fails", async () => {
    await seedOldArchive();
    await loadWorker();
    const lunrIndex = workerDbs[workerDbs.length - 1].lunrIndex;
    vi.spyOn(lunrIndex, "put").mockRejectedValue(new Error("QuotaExceededError"));
    const passes = vi.spyOn(lunrIndex, "clear");

    await send({ type: "init" }); // the first pass: the index is old
    await waitUntilIndexReady("wombat");
    expect(passes).toHaveBeenCalledTimes(1);
    expect(await lastIndexIncomplete()).toBeDefined();

    await send({ type: "init" }); // the one retry that HVN-50 allows
    await waitUntilIndexReady("wombat");
    expect(passes).toHaveBeenCalledTimes(2);

    await send({ type: "init" });
    await send({ type: "init" });
    expect(passes).toHaveBeenCalledTimes(2);
  });
});

/** A chat of messages, each with one prompt; the reply says nothing that is searched for. */
function buildThread(id: string, prompts: string[]): Chat {
  const chat = buildChat(id, "unused");
  const messages: Record<string, ChatMessage> = {};
  prompts.forEach((prompt, i) => {
    const msgId = `${id}-m${i + 1}`;
    messages[msgId] = {
      ...chat.messages[`${id}-m1`],
      id: msgId,
      message: [
        {
          kind: "request",
          parts: [{ part_kind: "user-prompt", content: prompt, timestamp: "t" }],
        },
        { kind: "response", parts: [{ part_kind: "text", content: "noted" }], timestamp: "t" },
      ] as ChatMessage["message"],
    };
  });
  chat.messages = messages;
  chat.currentId = `${id}-m${prompts.length}`;
  return chat;
}

describe("search worker: one indexing path (HVN-76)", () => {
  const MARK = "{{HIGHLIGHT}}pineapple{{/HIGHLIGHT}}";

  /** What a save does: write the row, then tell the index through the manager. */
  async function saveAndIndex(chat: Chat): Promise<void> {
    await seedChats([chat]);
    const { SearchIndexManager } = await import("../src/services/searchIndexManager");
    await SearchIndexManager.addOrUpdateChatInIndex(chat.id as string);
  }

  async function hydrated(query: string): Promise<SearchResult[]> {
    return (await search(query, true)).flatMap((c) => c.results as SearchResult[]);
  }

  // Blank lines in a message are collapsed in the text a snippet is cut from; the add used to
  // index the text as it was, so every position after a newline was off by that much.
  const SPACED = ["first line\n\n\nsecond line\n\n\nthird line\n\n\n".repeat(4), "the pineapple"];

  it("finds a chat saved on its own in the message that holds the word, marked on the word", async () => {
    await saveAndIndex(buildThread("one", SPACED));

    const results = await hydrated("pineapple");

    expect(results.map((r) => r.messageId)).toEqual(["one-m2"]);
    expect(results[0].messageSnippet).toContain(MARK);
  });

  it("finds the chat in the same message after a rebuild as after a save", async () => {
    await saveAndIndex(buildThread("one", SPACED));
    const saved = (await hydrated("pineapple")).map((r) => [r.messageId, r.messageSnippet]);

    await send({ type: "rebuild" });
    const rebuilt = (await hydrated("pineapple")).map((r) => [r.messageId, r.messageSnippet]);

    expect(saved).toHaveLength(1);
    expect(saved).toEqual(rebuilt);
  });

  it("finds the word of a chat that has a system prompt and a title before its messages", async () => {
    const chat = buildThread("sys", ["a\n\nb\n\nc", "the pineapple"]);
    chat.system = "You are\n\nhelpful.\n\nVery.";
    await saveAndIndex(chat);

    const results = await hydrated("pineapple");

    expect(results.map((r) => r.messageId)).toEqual(["sys-m2"]);
    expect(results[0].messageSnippet).toContain(MARK);
  });

  it("indexes the text the database holds when the add arrives, not what the sender had", async () => {
    await seedChats([buildThread("one", ["a first draft", "pineapple"])]);
    await seedChats([buildThread("one", ["the final text", "a wombat"])]);
    const { SearchIndexManager } = await import("../src/services/searchIndexManager");
    await SearchIndexManager.addOrUpdateChatInIndex("one");

    expect(await hydrated("wombat")).toHaveLength(1);
    expect(await hydrated("pineapple")).toHaveLength(0);
  });

  it("indexes nothing for a chat the database does not have", async () => {
    await send({ type: "add", chatId: "ghost" });

    expect(hitIds(await search("ghost", false))).toEqual([]);
  });

  describe("text past 100,000 characters", () => {
    const FILLER = "filler words here ".repeat(7000); // 126,000 characters

    it("is found after a rebuild, in its own message", async () => {
      await seedChats([buildThread("long", [FILLER, "the pineapple"])]);
      await send({ type: "rebuild" });

      const results = await hydrated("pineapple");

      expect(results.map((r) => r.messageId)).toEqual(["long-m2"]);
      expect(results[0].messageSnippet).toContain(MARK);
    });

    it("is found after a save, in the message that holds it", async () => {
      await saveAndIndex(buildThread("long", [`${FILLER} pineapple`]));

      const results = await hydrated("pineapple");

      expect(results.map((r) => r.messageId)).toEqual(["long-m1"]);
      expect(results[0].messageSnippet).toContain(MARK);
    });
  });
});

describe("search worker: a rebuild leaves soft-deleted chats out (HVN-74)", () => {
  async function seedThreeLiveOneDeleted(): Promise<void> {
    await seedChats([
      buildChat("a", "pineapple"),
      buildChat("b", "pineapple"),
      buildChat("c", "pineapple"),
      { ...buildChat("gone", "pineapple"), deleted: 1, deletedAt: Date.now() },
    ]);
  }

  const storedDocIds = async (): Promise<string[]> =>
    [...((await getDB().lunrIndex.get("segment_0"))?.meta as { docIds: string[] }).docIds].sort();

  it("does not index a chat in its grace period, so it is not there if it comes back by itself", async () => {
    await seedThreeLiveOneDeleted();

    await send({ type: "rebuild" });

    expect(await storedDocIds()).toEqual(["a", "b", "c"]);
  });

  it("counts the live chats, in the progress and in the end", async () => {
    await seedThreeLiveOneDeleted();

    await send({ type: "rebuild" });

    const progress = posted.filter((m) => m.type === "indexRebuildProgress");
    expect(progress.map((m) => (m.progress as RebuildStatus).total)).toEqual([3]);
    expect(posted.find((m) => m.type === "indexRebuildComplete")).toMatchObject({ totalChats: 3 });
  });

  it("is not told at the next start that a chat is missing from the index", async () => {
    await seedThreeLiveOneDeleted();
    await send({ type: "rebuild" });

    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady(); // a rebuild that init started would end here

    expect(posted.filter((m) => m.type === "indexRebuildComplete")).toEqual([]);
    expect(posted.filter((m) => m.type === "initProgress")).toEqual([]);
  });

  it("still starts a rebuild when a live chat is missing from the index", async () => {
    await seedThreeLiveOneDeleted();
    await send({ type: "rebuild" });
    await seedChats([buildChat("late", "pineapple")]);

    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady();

    expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(1);
    expect(await storedDocIds()).toEqual(["a", "b", "c", "late"]);
  });
});

describe("search worker: a rebuild that fails says so as it ends (HVN-74)", () => {
  it("posts the failure with its reason, and not a completion", async () => {
    await seedChats([buildChat("a", "pineapple")]);
    vi.spyOn(workerDbs[workerDbs.length - 1].lunrIndex, "put").mockRejectedValue(
      new Error("QuotaExceededError"),
    );

    await send({ type: "rebuild" });

    expect(posted.filter((m) => m.type === "indexRebuildFailed")).toEqual([
      { type: "indexRebuildFailed", error: "QuotaExceededError" },
    ]);
    expect(posted.some((m) => m.type === "indexRebuildComplete")).toBe(false);
  });

  it("posts nothing of the kind for a rebuild that succeeds", async () => {
    await seedChats([buildChat("a", "pineapple")]);

    await send({ type: "rebuild" });

    expect(posted.some((m) => m.type === "indexRebuildFailed")).toBe(false);
  });
});

describe("search worker: the limit counts chats (HVN-77)", () => {
  beforeEach(async () => {
    await getDB().chatMetadata.clear();
  });

  type Answer = { results: SearchResult[]; wasLimited: boolean | undefined; chunks: Posted[] };

  /** A hydrated search for "pineapple", with the limits and filters a caller can send. */
  async function limited(extra: Record<string, unknown> = {}): Promise<Answer> {
    const requestId = `test-${++requestCounter}`;
    await send({ type: "search", query: "pineapple", requestId, hydrate: true, ...extra });
    const chunks = posted.filter(
      (m) => m.type === "searchResultChunk" && m.requestId === requestId,
    );
    return {
      results: chunks.flatMap((c) => c.results as SearchResult[]),
      wasLimited: chunks[chunks.length - 1]?.wasLimited as boolean | undefined,
      chunks,
    };
  }

  const chatsOf = (results: SearchResult[]) => [...new Set(results.map((r) => r.chatId))].sort();

  /** A chat with `messages` messages that each hold the word. */
  const manyMatches = (id: string, messages: number) =>
    buildThread(
      id,
      Array.from({ length: messages }, (_, i) => `pineapple number ${i}`),
    );

  async function index(...chats: Chat[]): Promise<void> {
    await seedChats(chats);
    await send({ type: "rebuild" });
  }

  describe("the limit", () => {
    it("is a number of chats: five matching chats of six passages each, limit three, give three chats", async () => {
      await index(...["a", "b", "c", "d", "e"].map((id) => manyMatches(id, 6)));

      const { results, wasLimited } = await limited({ maxChats: 3 });

      expect(chatsOf(results)).toHaveLength(3);
      expect(wasLimited).toBe(true);
    });

    it("says it was not limited when the chats that match are exactly the limit", async () => {
      await index(...["a", "b", "c"].map((id) => manyMatches(id, 2)));

      const { results, wasLimited } = await limited({ maxChats: 3 });

      expect(chatsOf(results)).toEqual(["a", "b", "c"]);
      expect(wasLimited).toBe(false);
    });

    it("says it was not limited when fewer chats match than the limit", async () => {
      await index(manyMatches("a", 2));

      expect((await limited({ maxChats: 10 })).wasLimited).toBe(false);
    });

    it("does not count a chat the index holds but whose text no longer has the word", async () => {
      await index(manyMatches("a", 1), manyMatches("b", 1), manyMatches("c", 1));
      await seedChats([buildThread("a", ["nothing to find here"])]); // saved, not yet re-indexed

      const { results, wasLimited } = await limited({ maxChats: 2 });

      expect(chatsOf(results)).toEqual(["b", "c"]);
      expect(wasLimited).toBe(false);
    });

    it("does not count a chat that was deleted after it was indexed", async () => {
      await index(manyMatches("a", 1), manyMatches("b", 1), manyMatches("gone", 1));
      await getDB().chats.update("gone", { deleted: 1, deletedAt: Date.now() });

      const { results, wasLimited } = await limited({ maxChats: 2 });

      expect(chatsOf(results)).toEqual(["a", "b"]);
      expect(wasLimited).toBe(false);
    });
  });

  describe("passages per chat", () => {
    it("sends at most that many from a chat, whatever the limit on chats is", async () => {
      await index(manyMatches("a", 6), manyMatches("b", 1));

      const { results } = await limited({ passagesPerChat: 2 });

      expect(results.filter((r) => r.chatId === "a")).toHaveLength(2);
      expect(results.filter((r) => r.chatId === "b")).toHaveLength(1);
    });

    it("sends every passage when none is asked for", async () => {
      await index(manyMatches("a", 6));

      expect((await limited()).results).toHaveLength(6);
    });
  });

  describe("filters, which run before the cut", () => {
    const at = (chat: Chat, timestamp: number): Chat => ({ ...chat, timestamp });
    const DAY = 86_400_000;
    const NOW = 1_800_000_000_000;

    // Four chats match; the one that passes the filter has the longest text, so it ranks last.
    const crowd = (): Chat[] => [
      at(manyMatches("old1", 1), NOW - 30 * DAY),
      at(manyMatches("old2", 1), NOW - 31 * DAY),
      at(manyMatches("old3", 1), NOW - 32 * DAY),
      at(buildThread("new", ["pineapple", "filler ".repeat(400)]), NOW),
    ];

    it("finds the one chat inside a date range that is outranked by chats outside it", async () => {
      await index(...crowd());

      const { results, wasLimited } = await limited({
        maxChats: 2,
        filters: { after: NOW - DAY },
      });

      expect(chatsOf(results)).toEqual(["new"]);
      expect(wasLimited).toBe(false);
    });

    it("keeps the chats before a date with before", async () => {
      await index(...crowd());

      const { results } = await limited({ filters: { before: NOW - 30.5 * DAY } });

      expect(chatsOf(results)).toEqual(["old2", "old3"]);
    });

    it("limits the chats that pass the filter, and says so", async () => {
      await index(...crowd());

      const { results, wasLimited } = await limited({
        maxChats: 1,
        filters: { before: NOW - 29 * DAY },
      });

      expect(chatsOf(results)).toHaveLength(1);
      expect(chatsOf(results)[0]).toMatch(/^old/);
      expect(wasLimited).toBe(true);
    });

    describe("by category", () => {
      const meta = (chatId: string, categories: string[], source: "manual" | "unset" = "manual") =>
        getDB().chatMetadata.put({
          chatId,
          title: "",
          description: "",
          synopsis: "",
          categories,
          keywords: [],
          source,
          updatedAt: 1,
        });

      it("finds the chat in a category that the other matching chats are not in", async () => {
        await index(...crowd());
        await meta("old1", ["travel"]);
        await meta("old2", ["travel"]);
        await meta("new", ["code"]);

        const { results, wasLimited } = await limited({
          maxChats: 2,
          filters: { category: "code" },
        });

        expect(chatsOf(results)).toEqual(["new"]);
        expect(wasLimited).toBe(false);
      });

      it("finds the chats that have no metadata for _unset", async () => {
        await index(...crowd());
        await meta("old1", ["travel"]);
        await meta("old2", [], "unset");

        const { results } = await limited({ filters: { category: "_unset" } });

        expect(chatsOf(results)).toEqual(["new", "old2", "old3"]);
      });
    });
  });
});

describe("search worker: the query is parsed by us, not by Lunr (HVN-78)", () => {
  async function indexChats(...pairs: [string, string][]): Promise<void> {
    await seedChats(pairs.map(([id, text]) => buildChat(id, text)));
    await send({ type: "rebuild" });
  }

  const found = async (query: string): Promise<string[]> =>
    [...new Set(hitIds(await search(query, false)))].sort();

  const passages = async (query: string): Promise<SearchResult[]> =>
    (await search(query, true)).flatMap((c) => c.results as SearchResult[]);

  describe("a hyphen", () => {
    const CHATS: [string, string][] = [
      ["joined", "I like local-first software"],
      ["apart", "first the cat, then local"],
      ["only-local", "a local shop"],
      ["only-first", "the first shop"],
    ];

    it("means the same as a space: both words, and not either", async () => {
      await indexChats(...CHATS);

      expect(await found("local-first")).toEqual(["apart", "joined"]);
      expect(await found("local first")).toEqual(await found("local-first"));
    });

    it("means the same inside a phrase", async () => {
      await indexChats(...CHATS);

      expect(await found('"local-first"')).toEqual(["joined"]);
      expect(await found('"local first"')).toEqual(["joined"]);
    });
  });

  describe("punctuation that Lunr takes for syntax", () => {
    it("finds a word with a colon in it, and does not fail", async () => {
      await indexChats(["colon", "set foo:bar in the config"], ["other", "set foo and bar"]);

      expect(await found("foo:bar")).toEqual(["colon"]);
      expect((await passages("foo:bar")).map((p) => p.chatId)).toEqual(["colon"]);
    });

    it("breaks a word at a star inside it, and answers the same id-only and hydrated", async () => {
      await indexChats(["a", "foo and bar"], ["b", "foobar only"]);

      expect(await found("foo*bar")).toEqual(["a"]);
      expect([...new Set((await passages("foo*bar")).map((p) => p.chatId))]).toEqual(["a"]);
    });

    it("breaks a phrase at a star inside it too, and answers the same both ways", async () => {
      await indexChats(["w", "a wombat here"], ["x", "wombats galore"]);

      expect(await found('"wombat*"')).toEqual(["w"]);
      expect([...new Set((await passages('"wombat*"')).map((p) => p.chatId))]).toEqual(["w"]);
    });

    it("takes c++ templates as two words that both have to be there", async () => {
      await indexChats(
        ["both", "c++ templates are generic"],
        ["templates-only", "html templates are generic"],
        ["c-only", "learning c++ today"],
      );

      expect(await found("c++ templates")).toEqual(["both"]);
    });

    it("takes a plus, a caret or a tilde that is not an operator as part of the typing", async () => {
      await indexChats(["a", "the wombat sat"], ["b", "a numbat sat"]);

      expect(await found("wombat+")).toEqual(["a"]);
      expect(await found("(wombat)")).toEqual(["a"]);
      expect(await found("wombat~")).toEqual(["a"]);
    });
  });

  describe("the operators the CLI documents", () => {
    it("leaves out a word with a leading minus", async () => {
      await indexChats(["a", "alignment and rlhf"], ["b", "alignment alone"]);

      expect(await found("alignment -rlhf")).toEqual(["b"]);
    });

    it("matches a prefix typed with a trailing star", async () => {
      await indexChats(["a", "recursion is recursive"], ["b", "a rectangle"]);

      expect(await found("recurs*")).toEqual(["a"]);
    });

    it("finds a nearby spelling with ~N, and shows the passage that has it", async () => {
      await indexChats(["a", "we run kubernetes at work"], ["b", "we run nothing"]);

      expect(await found("kubernates~2")).toEqual(["a"]);
      const [passage] = await passages("kubernates~2");
      expect(passage.messageSnippet).toContain("{{HIGHLIGHT}}kubernetes{{/HIGHLIGHT}}");
    });

    it("takes ^N as a boost and still needs every word", async () => {
      await indexChats(["a", "api design notes"], ["b", "api only"]);

      expect(await found("api^5 design")).toEqual(["a"]);
    });

    it("keeps a quoted phrase exact", async () => {
      await indexChats(["a", "you may not recognize me"], ["b", "me not recognize may you"]);

      expect(await found('"may not recognize"')).toEqual(["a"]);
    });
  });

  describe("when the strict search finds nothing", () => {
    it("falls back to the prefixes of the words, without the stop words", async () => {
      await indexChats(["db", "how we migrate the database"], ["cook", "how to cook rice"]);

      // "quickly" is in neither, so the strict search is empty; "how" is in both, and says nothing.
      expect(await found("how should I migrate my database quickly")).toEqual(["db"]);
    });

    it("keeps the stop words when they are all the query has", async () => {
      await indexChats(["a", "to be or not to be"], ["b", "something else"]);

      expect(await found("to be or not")).toEqual(["a"]);
    });
  });

  describe("a phrase of stop words", () => {
    it("finds the chats that have the phrase", async () => {
      await indexChats(["a", "to be or not"], ["b", "not to be"], ["c", "do be well"]);

      expect(await found('"to be"')).toEqual(["a", "b"]);
    });
  });

  describe("a query with nothing to look for", () => {
    const problemOf = async (query: string) => {
      const [chunk] = await search(query, true);
      return chunk.queryProblem as string | undefined;
    };

    it("says so, rather than answering with no results", async () => {
      await indexChats(["a", "alignment"]);

      expect(await problemOf("-alignment")).toMatch(/not only words to leave out/);
      expect(await problemOf("* - ~2")).toMatch(/Type a word/);
      expect(await problemOf("alignment")).toBeUndefined();
    });

    it("does not return the chats that have a phrase typed to be left out", async () => {
      await indexChats(["a", "install wombat now"], ["b", "install a numbat"]);

      expect(await problemOf('install -"install wombat"')).toMatch(/Leaving out a phrase/);
      expect(await found('install -"install wombat"')).toEqual([]);
    });

    it("posts the problem as the last chunk, with no results", async () => {
      const [chunk] = await search("-alignment", true);

      expect(chunk).toMatchObject({ results: [], done: true });
    });
  });
});
