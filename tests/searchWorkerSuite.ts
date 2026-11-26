import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, SearchResult } from "../src/model/haevn_model";
import { saveChatToDb } from "../src/services/chatPersistence";
import { registerAllProviders } from "../src/providers/index";
import { parsePiJsonl } from "../src/providers/pi/importer";
import { transformPiToHaevnChat } from "../src/providers/pi/transformer";
import type { PoeConversationData } from "../src/providers/poe/model";
import { transformPoeToHaevn } from "../src/providers/poe/transformer";
import { getDB } from "../src/services/db";
import {
  BULK_WINDOW_KEY,
  type BulkWindow,
  endBulkWindow,
  openBulkWindow,
} from "../src/services/searchBulkWindow";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildQueryPlan } from "../src/services/searchWorkerQuery";
import { validateAndNormalizeChat } from "../src/utils/jsonImporter";
import { parseMarkdownContent } from "../src/utils/markdownImporter";
import { faults, opens, resetFaults, withFaults } from "./helpers/faultyIndex";
import { type IndexKit, mapKit, sqliteKit } from "./helpers/indexKit";

// The worker's tests run against two implementations of the index (HVN-87): SQLite itself, in
// memory, and a Map fixture. A test that passed only on SQLite would show that the seam leaks.
// `searchWorker.test.ts` runs this file on SQLite, `searchWorkerMap.test.ts` on the fixture.
const kit: IndexKit =
  (globalThis as { __haevnSearchKit?: string }).__haevnSearchKit === "map" ? mapKit : sqliteKit;

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

// The worker makes its index through `createSearchIndex`; give it the implementation under test,
// with writes that can be made to fail.
vi.mock("../src/services/searchIndex", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/searchIndex")>();
  return { ...original, createSearchIndex: () => withFaults(kit.create()) };
});

// The worker opens its own database; keep each one so a test can spy on its reads.
const workerDbs = vi.hoisted(
  () =>
    [] as Array<{
      chats: { offset: (n: number) => unknown; get: (...a: unknown[]) => unknown };
      chatMessages: { where: (...a: unknown[]) => unknown };
      cache: { put: (...a: unknown[]) => Promise<unknown> };
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

/** Chats as a save writes them: the messages in their table, and the row with none (HVN-31). */
async function seedChats(chats: Chat[]): Promise<void> {
  for (const chat of chats) {
    await saveChatToDb(chat);
  }
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.chatMessages.clear(), db.cache.clear()]);
  kit.reset();
  resetFaults();
  await loadWorker();
});

/** What the index has stored, as a second reader of its files sees it (not the worker). */
async function indexedChatIds(query = "pineapple"): Promise<string[]> {
  const reader = kit.create();
  await reader.open();
  try {
    return reader
      .search(buildQueryPlan(parseSearchQuery(query)))
      .map((r) => r.chatId)
      .sort();
  } finally {
    reader.close();
  }
}

/** Run until the worker has posted one more end of a rebuild pass than it had, good or bad. */
async function waitForPassEnd(endsBefore: number): Promise<void> {
  const ends = () =>
    posted.filter((m) => m.type === "indexRebuildComplete" || m.type === "indexRebuildFailed")
      .length;
  for (let i = 0; i < 2000 && ends() <= endsBefore; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (ends() <= endsBefore) throw new Error("the rebuild never ended");
}

const passEnds = () =>
  posted.filter((m) => m.type === "indexRebuildComplete" || m.type === "indexRebuildFailed").length;

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
    // Held after 100 of the 120 chats are read: 120 fit in one 1000-chat chunk, so only a per-read
    // counter says 100 here; a per-chunk counter would still say 0.
    const hold = holdRebuildAfter(100);
    const rebuild = send({ type: "rebuild" });
    await hold.paused;

    const [chunk] = await search("pineapple", true);

    expect(chunk.indexRebuilding).toMatchObject({ processed: 100, total: 120 });
    hold.resume();
    await rebuild;
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

    // A fresh worker (the offscreen document restarted) opens the stored index, which still
    // holds the deleted chat.
    await loadWorker();
    await send({ type: "init" });

    expect(hitIds(await search("pineapple", false))).toEqual(["keep"]);
  });
});

type RebuildStatus = { processed: number; total: number; percentage: number };

/** Poll with searches until the worker answers without a rebuild status. */
async function waitUntilIndexReady(query = "pineapple"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const [chunk] = await search(query, false);
    if (chunk.indexRebuilding === undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the index never became ready");
}

describe("search worker: a chat the database holds in an odd shape (HVN-87)", () => {
  it("rebuilds the index with it in, instead of failing the whole rebuild", async () => {
    const odd = buildChat("odd", "a wombat");
    (odd as unknown as { source: unknown }).source = undefined;
    (odd as unknown as { timestamp: unknown }).timestamp = Number.NaN;
    await seedChats([odd, buildChat("fine", "a wombat")]);

    await send({ type: "rebuild" });

    expect(lastReply().success).toBe(true);
    expect(new Set(hitIds(await search("wombat", false)))).toEqual(new Set(["odd", "fine"]));
  });
});

describe("search worker: a rebuild that fails (HVN-50)", () => {
  /**
   * 200 good chats, and "zzz-bad", whose message list cannot be read: a rebuild reads the good
   * ones and fails on the bad one, and the new file is thrown away.
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

  /** An index of the 200 good chats that is whole, and then a rebuild that fails on "zzz-bad". */
  async function failAfterAGoodIndex(): Promise<void> {
    await seedChats(
      Array.from({ length: 200 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
    );
    await send({ type: "rebuild" });
    expect(lastBulkComplete().success).toBe(true);
    const bad = buildChat("zzz-bad", "pineapple");
    (bad.messages["zzz-bad-m1"] as { message: unknown }).message = 42;
    await seedChats([bad]);
    await send({ type: "rebuild" });
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

  it("answers from the index it had, and marks the search, when a later rebuild fails", async () => {
    await failAfterAGoodIndex();

    for (const hydrate of [false, true]) {
      const chunks = await search("pineapple", hydrate);

      expect(new Set(hitIds(chunks)).size).toBe(200);
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

  it("recovers on the next init, even when the index it kept already holds every chat", async () => {
    await failAfterAGoodIndex();
    // The index of the 200 chats answers: once the bad chat is gone, a count of chats against
    // indexed documents sees nothing wrong, so only the failure itself can start the rebuild.
    await getDB().chats.delete("zzz-bad");
    const before = passEnds();

    await send({ type: "init" });
    await waitForPassEnd(before);

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

describe("search worker: a second request around a rebuild (HVN-50)", () => {
  it("answers from the index it has while a rebuild writes the new one, and the add lands in both", async () => {
    await seedChats(
      Array.from({ length: 120 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "pineapple"),
      ),
    );
    await send({ type: "rebuild" });
    const before = passEnds();

    const rebuild = send({ type: "rebuild" });
    const during = await search("pineapple", false);
    await seedChats([buildChat("fresh", "mango")]);
    await send({ type: "add", chatId: "fresh" });

    // Not "rebuilding", and not empty: the old index answers, and it has the new chat at once.
    expect(during.every((chunk) => chunk.indexRebuilding === undefined)).toBe(true);
    expect(new Set(hitIds(during)).size).toBe(120);
    expect(hitIds(await search("mango", false))).toEqual(["fresh"]);

    await rebuild;
    expect(passEnds()).toBe(before + 1);
    expect(hitIds(await search("mango", false))).toEqual(["fresh"]);
    expect(new Set(hitIds(await search("pineapple", false))).size).toBe(120);
  });

  it("leaves a chat that was removed during a rebuild out of the new index", async () => {
    await seedChats([buildChat("keep", "pineapple"), buildChat("gone", "pineapple")]);
    await send({ type: "rebuild" });

    const rebuild = send({ type: "rebuild" });
    await getDB().chats.delete("gone");
    await send({ type: "removeMany", chatIds: ["gone"] });
    await rebuild;

    expect(hitIds(await search("pineapple", false))).toEqual(["keep"]);
    expect(await indexedChatIds()).toEqual(["keep"]);
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
    const before = passEnds();
    await send({ type: "init" });

    // The retry runs: one more pass ends (and fails again, on the same chat).
    await waitForPassEnd(before);
    expect(posted.filter((m) => m.type === "indexRebuildFailed")).toHaveLength(3);
  });

  it("rebuilds after a worker restart that follows a failed rebuild, when the index it kept is short", async () => {
    await seedGoodChats(400, "pineapple");
    await send({ type: "rebuild" }); // a whole index of 400 chats
    await seedChats(
      Array.from({ length: 5 }, (_, i) => buildChat(`n${i}`, "mango")), // saved, never indexed
    );
    await seedChats([unreadable("c399", "mango")]);
    await send({ type: "rebuild" });
    expect(lastReply().success).toBe(false);
    await seedChats([buildChat("c399", "pineapple")]); // repaired

    await loadWorker(); // the offscreen document went away and came back
    await send({ type: "init" });
    await waitForPassEnd(0); // the index it opens has 400 of 405 chats: a rebuild starts

    const chunks = await search("mango", false);
    expect(chunks.every((c) => c.indexIncomplete === undefined)).toBe(true);
    expect(new Set(hitIds(chunks)).size).toBe(5);
    expect(new Set(hitIds(await search("pineapple", false))).size).toBe(400);
  });

  it("counts a failed write to the index as a failed rebuild", async () => {
    await seedGoodChats(205, "pineapple");
    faults.put = new Error("QuotaExceededError");
    faults.putAfter = 3;

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

  it("indexes the new text of a chat the rebuild had read, 100 of 120 in", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["c000"]);
  });

  it("indexes the new text of a chat the rebuild had read, 250 of 300 in", async () => {
    const { rebuild, hold } = await startHeldRebuild(300, 250);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    expect(hitIds(await search("mango", false))).toEqual(["c000"]);
  });

  it("keeps the new text of a chat the rebuild had read in the file it wrote", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);

    await rewriteAndAdd("c000", "mango");
    hold.resume();
    await rebuild;

    // A reader of the stored files, not the worker's own memory, finds it.
    expect(await indexedChatIds("mango")).toEqual(["c000"]);
    expect(await indexedChatIds("pineapple")).toHaveLength(119);
  });

  it("indexes an add that arrives while the rebuild is reading the earlier ones", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);
    const db = workerDbs[workerDbs.length - 1] as unknown as {
      chats: { bulkGet: (...a: unknown[]) => Promise<unknown> };
    };
    const bulkGet = db.chats.bulkGet.bind(db.chats);
    const reading = newHold();
    let calls = 0;
    // The first bulkGet is the one that reads the adds the pass was told of.
    vi.spyOn(db.chats, "bulkGet").mockImplementation(((...args: unknown[]) => {
      calls += 1;
      if (calls !== 1) return bulkGet(...args);
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

  it("fails the rebuild when the write of an add cannot be made", async () => {
    const { rebuild, hold } = await startHeldRebuild(120, 100);
    // The pass's own 120 writes go through; the one for the add does not.
    faults.put = new Error("QuotaExceededError");
    faults.putAfter = 120;

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

  // A position in the lower-cased text is not one in the text, where "İ" is one unit (HVN-57):
  // the marks come from the index, which never lower-cases the text it shows.
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
    // The phrase is one mark, as the index matched it: the words and what stands between them.
    expect(result.messageSnippet).toContain("say {{HIGHLIGHT}}hello world{{/HIGHLIGHT}}, please");
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
  const rebuilds = () => posted.filter((m) => m.type === "indexRebuildComplete").length;

  async function restart(): Promise<void> {
    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
  }

  /** Chats, and an index of another format of them: what an earlier release leaves behind. */
  async function seedOldArchive(format = 2): Promise<void> {
    await seedChats([
      buildChat("comma", "I saw a wombat, then left"),
      buildChat("plain", "a wombat"),
    ]);
    await kit.seedFormat(format);
  }

  async function lastIndexIncomplete(): Promise<unknown> {
    const chunks = await search("wombat", false);
    return chunks[chunks.length - 1].indexIncomplete;
  }

  it("rebuilds an index in another format once, and not again at the starts after", async () => {
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

  it("tells a search that comes right after the start that the index is rebuilding", async () => {
    await seedOldArchive();
    await loadWorker();

    await send({ type: "init" });
    const [chunk] = await search("wombat", false);

    expect(chunk.results).toEqual([]);
    expect(chunk.indexRebuilding).toBeDefined();
    await waitUntilIndexReady("wombat");
  });

  it("rebuilds an index of a format it does not know, as a downgrade would meet", async () => {
    await seedOldArchive(99);

    await restart();

    expect(rebuilds()).toBe(1);
    expect(new Set(hitIds(await search("wombat", false)))).toEqual(new Set(["comma", "plain"]));
  });

  it("rebuilds nothing, and has an index in the current format, for an archive that has none yet", async () => {
    await loadWorker();
    await send({ type: "init" });

    expect(rebuilds()).toBe(0);

    // The chats that arrive later are indexed into it, so the next start has nothing to rebuild.
    await seedChats([buildChat("late", "a wombat")]);
    await send({ type: "add", chatId: "late" });
    await send({ type: "endBulk" });
    expect(hitIds(await search("wombat", false))).toEqual(["late"]);
    await restart();
    expect(rebuilds()).toBe(0);
    expect(hitIds(await search("wombat", false))).toEqual(["late"]);
  });

  it("has no index of its own after a first rebuild that failed, so the next start rebuilds", async () => {
    await seedChats([buildChat("c1", "a wombat")]);
    const bad = buildChat("zzz-bad", "a wombat");
    (bad.messages["zzz-bad-m1"] as { message: unknown }).message = 42;
    await seedChats([bad]);
    await send({ type: "rebuild" });
    expect(lastReply().success).toBe(false);
    await getDB().chats.delete("zzz-bad");

    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");

    expect(rebuilds()).toBe(1);
    expect(hitIds(await search("wombat", false))).toEqual(["c1"]);
  });

  it("does not rebuild in a loop when the rebuild of an old index fails", async () => {
    await seedOldArchive();
    await loadWorker();
    faults.put = new Error("QuotaExceededError");
    const failures = () => posted.filter((m) => m.type === "indexRebuildFailed").length;

    await send({ type: "init" }); // the first pass: the index is in another format
    await waitUntilIndexReady("wombat");
    expect(failures()).toBe(1);
    expect(await lastIndexIncomplete()).toBeDefined();

    const before = passEnds();
    await send({ type: "init" }); // the one retry that HVN-50 allows
    await waitForPassEnd(before);
    expect(failures()).toBe(2);

    await send({ type: "init" });
    await send({ type: "init" });
    expect(failures()).toBe(2);
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

  // A started worker has an index to add to (an empty archive gets an empty one).
  beforeEach(async () => {
    await send({ type: "init" });
  });

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

  const storedDocIds = (): Promise<string[]> => indexedChatIds();

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
    await waitForPassEnd(0);

    expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(1);
    expect(await storedDocIds()).toEqual(["a", "b", "c", "late"]);
  });
});

describe("search worker: a rebuild that fails says so as it ends (HVN-74)", () => {
  it("posts the failure with its reason, and not a completion", async () => {
    await seedChats([buildChat("a", "pineapple")]);
    faults.put = new Error("QuotaExceededError");

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

    it("stops counting a chat once the index is told that its text no longer has the word", async () => {
      await index(manyMatches("a", 1), manyMatches("b", 1), manyMatches("c", 1));
      await seedChats([buildThread("a", ["nothing to find here"])]); // saved
      await send({ type: "add", chatId: "a" }); // and indexed, as a save does

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

    it("reads the row of the chats that pass the filter, and of no other, and no message at all", async () => {
      await index(...crowd());
      const db = workerDbs[workerDbs.length - 1];
      const messageReads = vi.spyOn(db.chatMessages, "where");
      const rowReads = vi.spyOn(db.chats, "get");

      const { results } = await limited({ filters: { after: NOW - DAY } });

      expect(chatsOf(results)).toEqual(["new"]);
      expect(rowReads).toHaveBeenCalledTimes(1);
      expect(messageReads).not.toHaveBeenCalled();
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

describe("search worker: the query is parsed by us, not by the index (HVN-78)", () => {
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

  describe("punctuation that a query language would take for syntax", () => {
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

    it("accepts ^N and ignores it, and still needs every word", async () => {
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

    it("says so for a pasted paragraph, instead of failing the search", async () => {
      await indexChats(["a", "alignment"]);
      const paragraph = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");

      expect(await problemOf(paragraph)).toMatch(/more than 100 words and phrases/);
      const chunks = await search(paragraph, true);
      expect(chunks.some((c) => c.type === "error")).toBe(false);
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

describe("search worker: an index file that cannot be opened (HVN-87)", () => {
  const REASON = "Access Handles cannot be created: another worker holds the file";
  const lastChunk = (chunks: Posted[]) => chunks[chunks.length - 1];

  beforeEach(async () => {
    await seedChats([buildChat("a", "a pineapple"), buildChat("b", "a pineapple")]);
  });

  it("says why on a search that follows init, and finds nothing", async () => {
    faults.open = new Error(REASON);
    faults.openFailures = 5;
    await send({ type: "init" });

    const chunks = await search("pineapple", false);

    expect(hitIds(chunks)).toEqual([]);
    expect(lastChunk(chunks).indexIncomplete).toEqual({ error: REASON });
  });

  it("says why on a search that is the first message, the one that opens the file", async () => {
    faults.open = new Error(REASON);
    faults.openFailures = 5;

    const chunks = await search("pineapple", true);

    expect(hitIds(chunks)).toEqual([]);
    expect(lastChunk(chunks).indexIncomplete).toEqual({ error: REASON });
  });

  it("opens the file again at the next init, and answers once it is open", async () => {
    faults.open = new Error(REASON);
    faults.openFailures = 1;
    await send({ type: "init" });
    expect(lastChunk(await search("pineapple", false)).indexIncomplete).toEqual({ error: REASON });
    const before = passEnds();

    await send({ type: "init" }); // the file is free now
    await waitForPassEnd(before);

    const chunks = await search("pineapple", false);
    expect(new Set(hitIds(chunks))).toEqual(new Set(["a", "b"]));
    expect(lastChunk(chunks).indexIncomplete).toBeUndefined();
    expect(opens.count).toBe(2);
  });
});

describe("search worker: the chats a bulk operation saves (HVN-87)", () => {
  /** A chat as a bulk save leaves it: in the database, saved at `savedAt`, not in the index. */
  function saved(id: string, text: string, savedAt: number): Chat {
    return { ...buildChat(id, text), lastSyncedTimestamp: savedAt };
  }

  async function startWithAnIndex(): Promise<void> {
    await seedChats([buildChat("old", "a wombat")]);
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
  }

  /** The catch-up runs in the background after `endBulk`: wait until `query` finds `ids`. */
  async function foundAfterCatchUp(query: string, ids: string[]): Promise<string[]> {
    let found: string[] = [];
    for (let i = 0; i < 200; i++) {
      found = [...new Set(hitIds(await search(query, false)))].sort();
      if (found.length >= ids.length) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return found;
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finds the chats that were saved between startBulk and endBulk", async () => {
    await startWithAnIndex();

    await send({ type: "startBulk" });
    await seedChats([saved("a", "a quokka", Date.now()), saved("b", "a quokka", Date.now())]);
    await send({ type: "endBulk" });

    expect(await foundAfterCatchUp("quokka", ["a", "b"])).toEqual(["a", "b"]);
  });

  it("takes a chat saved just before startBulk, inside the margin, and not one saved long before", async () => {
    await startWithAnIndex();
    const now = Date.now();

    await send({ type: "startBulk" });
    await seedChats([
      saved("inside", "a quokka", now - 500),
      saved("outside", "a quokka", now - 5000),
    ]);
    await send({ type: "endBulk" });

    expect(await foundAfterCatchUp("quokka", ["inside"])).toEqual(["inside"]);
    // Given time to be wrongly caught too.
    await new Promise((r) => setTimeout(r, 50));
    expect([...new Set(hitIds(await search("quokka", false)))]).toEqual(["inside"]);
  });

  it("keeps the window of a bulk operation that is resumed, as bulk sync does after a restart", async () => {
    await startWithAnIndex();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));

    await send({ type: "startBulk" });
    await seedChats([saved("early", "a quokka", Date.now())]);
    vi.setSystemTime(new Date("2026-11-18T10:00:30Z")); // the operation is paused, then resumed
    await send({ type: "startBulk" });
    await seedChats([saved("late", "a quokka", Date.now())]);
    await send({ type: "endBulk" });

    expect(await foundAfterCatchUp("quokka", ["early", "late"])).toEqual(["early", "late"]);
  });

  it("starts a new window for the next bulk operation", async () => {
    await startWithAnIndex();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    await send({ type: "startBulk" });
    await send({ type: "endBulk" });
    // Its catch-up has settled: until then the window is still owed, and the next operation keeps
    // its time (HVN-88, "keeps the older time" in searchBulkWindow.test.ts).
    for (let i = 0; i < 400 && (await getDB().cache.get(BULK_WINDOW_KEY)); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await getDB().cache.get(BULK_WINDOW_KEY)).toBeUndefined();

    vi.setSystemTime(new Date("2026-11-18T11:00:00Z"));
    await send({ type: "startBulk" });
    await seedChats([
      saved("stale", "a quokka", new Date("2026-11-18T10:30:00Z").getTime()),
      saved("fresh", "a quokka", Date.now()),
    ]);
    await send({ type: "endBulk" });

    expect(await foundAfterCatchUp("quokka", ["fresh"])).toEqual(["fresh"]);
    await new Promise((r) => setTimeout(r, 50));
    expect([...new Set(hitIds(await search("quokka", false)))]).toEqual(["fresh"]);
  });
});

describe("search worker: a bulk window survives a restart of the worker (HVN-88)", () => {
  /** A chat as a bulk save leaves it: in the database, saved at `savedAt`, not in the index. */
  function saved(id: string, text: string, savedAt: number): Chat {
    return { ...buildChat(id, text), lastSyncedTimestamp: savedAt };
  }

  const windowRow = () => getDB().cache.get(BULK_WINDOW_KEY);
  const windowOf = async () => (await windowRow())?.value as BulkWindow | undefined;
  const rebuilds = () => posted.filter((m) => m.type === "indexRebuildComplete").length;

  /** Chat "old" is in the index, as an earlier session left it. */
  async function startWithAnIndex(): Promise<void> {
    await seedChats([buildChat("old", "a wombat")]);
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
  }

  /** The worker is gone and a new one starts, as an offscreen document that closed leaves it. */
  async function restartWithInit(): Promise<void> {
    await loadWorker();
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
  }

  /** The ids `query` finds now. */
  async function found(query: string): Promise<string[]> {
    return [...new Set(hitIds(await search(query, false)))].sort();
  }

  /** Wait until `check` holds, for work the worker does in the background. */
  async function until(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("the worker never got there");
  }

  /** Give background work that should NOT happen a fair chance to happen. */
  const settle = () => new Promise((r) => setTimeout(r, 100));

  afterEach(() => {
    vi.useRealTimers();
  });

  it("catches up at the next init when the worker restarted mid-bulk, and a chat was updated", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    // The same count of chats, so the consistency check at init has nothing to rebuild.
    await seedChats([saved("old", "a quokka", Date.now())]);

    await restartWithInit();

    await until(async () => (await found("quokka")).length > 0);
    expect(await found("quokka")).toEqual(["old"]);
    expect(rebuilds()).toBe(0);
  });

  it("catches up at endBulk when the worker restarted mid-bulk and got no init first", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    await seedChats([saved("old", "a quokka", Date.now())]);
    await loadWorker(); // a worker that has opened nothing yet

    await send({ type: "endBulk" });

    await until(async () => (await found("quokka")).length > 0);
    expect(await found("quokka")).toEqual(["old"]);
    await until(async () => (await windowRow()) === undefined);
  });

  it("catches up an operation that had ended when the worker went, before its catch-up finished", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    await seedChats([saved("old", "a quokka", Date.now())]);
    // endBulk's reply was sent and the window marked, then the worker went.
    await endBulkWindow(getDB());

    await restartWithInit();

    await until(async () => (await found("quokka")).length > 0);
    expect(await found("quokka")).toEqual(["old"]);
    await until(async () => (await windowRow()) === undefined);
  });

  it("clears the window after the catch-up of a normal endBulk", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    expect(await windowOf()).toMatchObject({ ended: false });
    await seedChats([saved("old", "a quokka", Date.now())]);
    await send({ type: "endBulk" });
    await until(async () => (await found("quokka")).length > 0);
    await until(async () => (await windowRow()) === undefined);

    // Nothing is owed any more: an update after it is not found by the next start.
    await seedChats([saved("old", "a lemur", Date.now())]);
    await restartWithInit();
    await settle();
    expect(await found("lemur")).toEqual([]);
    expect(await found("quokka")).toEqual(["old"]);
  });

  it("catches up nothing at init when no bulk window was opened", async () => {
    await startWithAnIndex();
    await seedChats([saved("old", "a quokka", Date.now())]); // updated, in no window

    await restartWithInit();
    await settle();

    expect(await found("quokka")).toEqual([]);
    expect(await found("wombat")).toEqual(["old"]);
    expect(await windowRow()).toBeUndefined();
  });

  it("keeps a window that has not ended after the catch-up at init, moved forward", async () => {
    await startWithAnIndex();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
    await send({ type: "startBulk" });
    const began = (await windowOf()) as BulkWindow;
    await seedChats([saved("old", "a quokka", Date.now())]);
    vi.setSystemTime(new Date("2026-11-18T10:05:00Z"));

    await restartWithInit();
    await until(async () => (await found("quokka")).length > 0);
    await until(async () => ((await windowOf()) as BulkWindow).since > began.since);

    // The operation is still running. The window starts where the catch-up began, less the margin
    // (a chat stamped just before it may be committed just after the read).
    expect(await windowOf()).toMatchObject({
      ended: false,
      since: new Date("2026-11-18T10:05:00Z").getTime() - 1000,
    });
    // It saves another chat and ends.
    await seedChats([saved("late", "a quokka", Date.now())]);
    await send({ type: "endBulk" });
    await until(async () => (await found("quokka")).length === 2);
    expect(await found("quokka")).toEqual(["late", "old"]);
    await until(async () => (await windowRow()) === undefined);
  });

  it("keeps the window when the catch-up failed, so that the next start tries again", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    await seedChats([saved("old", "a quokka", Date.now())]);
    faults.put = new Error("QuotaExceededError");
    faults.putAfter = 0;
    await send({ type: "endBulk" });
    await settle();
    expect(await windowRow()).toBeDefined();
    expect(await found("quokka")).toEqual([]);

    resetFaults();
    await restartWithInit();
    await until(async () => (await found("quokka")).length > 0);
    expect(await found("quokka")).toEqual(["old"]);
    await until(async () => (await windowRow()) === undefined);
  });

  it("keeps the window when there is no index of this format to put the chats in", async () => {
    await seedChats([buildChat("old", "a wombat")]);
    await kit.seedFormat(99); // an index that an earlier release left, which this one cannot read
    await loadWorker();
    await send({ type: "startBulk" });
    await seedChats([saved("new", "a quokka", Date.now())]);

    await send({ type: "endBulk" });
    await settle();

    // The next start rebuilds from the database, and then the window is paid.
    expect(await windowOf()).toMatchObject({ ended: true });
    await restartWithInit();
    await until(async () => (await found("quokka")).length > 0);
    await until(async () => (await windowRow()) === undefined);
  });

  it("keeps the window when the rebuild that the catch-up joined failed", async () => {
    await seedChats(
      Array.from({ length: 120 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "a wombat"),
      ),
    );
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
    await openBulkWindow(getDB(), Date.now() - 1000);
    await endBulkWindow(getDB());

    // A new worker, with a rebuild running (held after its first page) when it starts.
    await loadWorker();
    const hold = holdRebuildAfter(50);
    faults.put = new Error("QuotaExceededError");
    faults.putAfter = 60;
    const rebuild = send({ type: "rebuild" });
    await hold.paused;
    await send({ type: "init" }); // finds the window, and joins the rebuild
    hold.resume();
    await rebuild;
    await settle();

    expect(posted.some((m) => m.type === "indexRebuildFailed")).toBe(true);
    expect(await windowRow()).toBeDefined();
  });

  it("clears the window once the rebuild that the catch-up joined has succeeded", async () => {
    await seedChats(
      Array.from({ length: 120 }, (_, i) =>
        buildChat(`c${String(i).padStart(3, "0")}`, "a wombat"),
      ),
    );
    await send({ type: "init" });
    await waitUntilIndexReady("wombat");
    await openBulkWindow(getDB(), Date.now() - 1000);
    await endBulkWindow(getDB());

    await loadWorker();
    const hold = holdRebuildAfter(50);
    const rebuild = send({ type: "rebuild" });
    await hold.paused;
    await send({ type: "init" });
    hold.resume();
    await rebuild;

    await until(async () => (await windowRow()) === undefined);
  });

  it("carries on when the window cannot be written, and still catches up at endBulk", async () => {
    await startWithAnIndex();
    const put = vi
      .spyOn(workerDbs[workerDbs.length - 1].cache, "put")
      .mockRejectedValue(new Error("QuotaExceededError"));
    await send({ type: "startBulk" });
    expect(posted.filter((m) => m.type === "bulkComplete").pop()).toMatchObject({ success: true });
    await seedChats([saved("old", "a quokka", Date.now())]);

    await send({ type: "endBulk" });
    put.mockRestore();

    expect(posted.some((m) => m.type === "error")).toBe(false);
    await until(async () => (await found("quokka")).length > 0);
    expect(await found("quokka")).toEqual(["old"]);
  });

  it("keeps the window when the index could not be opened for the catch-up", async () => {
    await startWithAnIndex();
    await send({ type: "startBulk" });
    await seedChats([saved("old", "a quokka", Date.now())]);
    await loadWorker();
    faults.open = new Error("the file is busy");
    faults.openFailures = 5;

    await send({ type: "endBulk" });
    await settle();

    expect(await windowRow()).toBeDefined();
  });
});

describe("search worker: models and tags (HVN-164)", () => {
  /** Chats as the providers make them: one synced from the web, three imported from files. */
  async function archive(): Promise<Record<"synced" | "markdown" | "json" | "session", Chat>> {
    registerAllProviders();
    const turn = (id: number, text: string, bot: boolean) =>
      ({
        id: `msg-${id}`,
        messageId: id,
        messageCode: `code-${id}`,
        authorUser: bot ? null : { uid: 1, id: "user-1", fullName: "U", handle: "u" },
        bot: bot
          ? { botId: 4, id: "bot-4", displayName: "Bot", deletionState: "not_deleted" }
          : null,
        text,
        contentType: "text_markdown",
        sourceType: "chat_input",
        state: "complete",
        creationTime: 1714557480000000 + id * 1000,
        isEdited: false,
        isDeleted: false,
        isChatAnnouncement: false,
        hasCitations: false,
        attachments: [],
        referencedMessageV2: null,
        usersCanEdit: [],
        messageStateText: null,
        parameters: null,
        command: null,
      }) as unknown as PoeConversationData["messages"][number];
    const [synced] = await transformPoeToHaevn({
      chatId: "Q2hhdDoxMjM=",
      chatCode: "poe-synced",
      title: "A synced chat",
      botName: "Claude-in-Poe",
      extractedAt: "2024-05-10T10:00:00.000Z",
      messages: [turn(1, "hello", false), turn(2, "hi there", true)],
    });

    const markdown = await parseMarkdownContent(`---
title: An imported file
conversation_id: md-imported
models_used:
  - gemini-2.5-pro
---

<!-- HAEVN: role="user" -->
hello

<!-- HAEVN: role="assistant" -->
hi there
`);

    const json = validateAndNormalizeChat(
      {
        id: "json-imported",
        title: "An imported backup",
        source: "claude",
        currentId: "m1",
        models: ["claude-opus-4"],
        tags: ["archive-2023", "starred"],
        messages: { m1: buildChat("json-imported", "hello").messages["json-imported-m1"] },
      },
      "hash",
    );

    const session = transformPiToHaevnChat(
      await parsePiJsonl(
        [
          { type: "session", version: 3, id: "pi-imported", timestamp: "2026-03-23T10:00:00.000Z" },
          {
            type: "message",
            id: "u-1",
            timestamp: "2026-03-23T10:00:02.000Z",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
          {
            type: "message",
            id: "a-1",
            timestamp: "2026-03-23T10:00:03.000Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "hi there" }],
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      ),
    );
    return { synced, markdown, json, session };
  }

  /** A hydrated search: the passages the archive and the CLI show. */
  async function passages(query: string): Promise<SearchResult[]> {
    const requestId = `test-${++requestCounter}`;
    await send({ type: "search", query, requestId, hydrate: true });
    return posted
      .filter((m) => m.type === "searchResultChunk" && m.requestId === requestId)
      .flatMap((m) => m.results as SearchResult[]);
  }

  const chatsOf = (results: SearchResult[]) => [...new Set(results.map((r) => r.chatId))].sort();

  it("finds synced and imported chats by their model and their tag", async () => {
    const chats = await archive();
    await seedChats(Object.values(chats));
    await send({ type: "rebuild" });

    // The synced chat: Poe's bot is its model, and its tags are the platform and the bot.
    expect(chatsOf(await passages("model:claude-in-poe"))).toEqual(["poe-synced"]);
    expect(chatsOf(await passages("tag:poe"))).toEqual(["poe-synced"]);
    // The three imports, one for each way a chat gets in without a provider's own sync.
    expect(chatsOf(await passages("model:gemini-2.5-pro"))).toEqual(["md-imported"]);
    expect(chatsOf(await passages("tag:archive-2023"))).toEqual(["json-imported"]);
    expect(chatsOf(await passages("model:claude-opus-4"))).toEqual(["json-imported"]);
    expect(chatsOf(await passages("model:claude-sonnet-4-6"))).toEqual(["pi-imported"]);
  });

  it("finds them by a model typed as a plain word, and says which label it was", async () => {
    const chats = await archive();
    await seedChats(Object.values(chats));
    await send({ type: "rebuild" });

    const found = await passages("starred");

    expect(chatsOf(found)).toEqual(["json-imported"]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      label: "tag",
      messageContent: "starred",
      messageSnippet: "{{HIGHLIGHT}}starred{{/HIGHLIGHT}}",
    });
  });

  it("does not call a message a label, or a label a message", async () => {
    const chats = await archive();
    await seedChats(Object.values(chats));
    await send({ type: "rebuild" });

    const [text] = await passages("hello");
    const label = (await passages("tag:starred"))[0];

    expect(text.label).toBeUndefined();
    expect(label.label).toBe("tag");
  });

  it("finds a chat by its tag as soon as it is saved, without a rebuild", async () => {
    await seedChats([buildChat("first", "pineapple")]);
    await send({ type: "rebuild" });
    const later = { ...buildChat("later", "mango"), tags: ["fresh-tag"], models: ["new-model-1"] };
    await seedChats([later]);

    await send({ type: "add", chatId: "later" });

    expect(chatsOf(await passages("tag:fresh-tag"))).toEqual(["later"]);
    expect(chatsOf(await passages("model:new-model-1"))).toEqual(["later"]);
  });

  it("indexes a chat's new tags when it is saved again, and drops the old ones", async () => {
    const chat = { ...buildChat("again", "pineapple"), tags: ["before"] };
    await seedChats([chat]);
    await send({ type: "rebuild" });
    expect(chatsOf(await passages("tag:before"))).toEqual(["again"]);

    await seedChats([{ ...chat, tags: ["after"] }]);
    await send({ type: "add", chatId: "again" });

    expect(chatsOf(await passages("tag:before"))).toEqual([]);
    expect(chatsOf(await passages("tag:after"))).toEqual(["again"]);
  });

  it("does not find a label with the relaxed search that finds near words", async () => {
    await seedChats([{ ...buildChat("one", "pineapple"), tags: ["poetry"] }]);
    await send({ type: "rebuild" });

    expect(chatsOf(await passages("tag:poetr"))).toEqual([]);
    expect(chatsOf(await passages("tag:poetr*"))).toEqual(["one"]);
  });

  describe("an index from before there were labels", () => {
    // Format 3 is what a release before HVN-164 leaves: the same tables, and no label rows.
    const BEFORE_LABELS = 3;

    it("is not read: the worker says it is rebuilding, rebuilds on its own, and then finds the labels", async () => {
      await seedChats([{ ...buildChat("old", "pineapple"), tags: ["kept-tag"], models: ["m-1"] }]);
      await kit.seedFormat(BEFORE_LABELS);
      await loadWorker();

      await send({ type: "init" });
      const [during] = await search("tag:kept-tag", false);

      expect(during.results).toEqual([]);
      expect(during.indexRebuilding).toBeDefined(); // "not searched", never "no matches"
      await waitUntilIndexReady("tag:kept-tag");
      expect(chatsOf(await passages("tag:kept-tag"))).toEqual(["old"]);
      expect(chatsOf(await passages("model:m-1"))).toEqual(["old"]);
      expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(1);
    });

    it("is rebuilt once, and the next start finds the labels without rebuilding", async () => {
      await seedChats([{ ...buildChat("old", "pineapple"), tags: ["kept-tag"] }]);
      await kit.seedFormat(BEFORE_LABELS);
      await loadWorker();
      await send({ type: "init" });
      await waitUntilIndexReady("tag:kept-tag");

      await loadWorker();
      await send({ type: "init" });

      expect(posted.filter((m) => m.type === "indexRebuildComplete")).toHaveLength(0);
      expect(chatsOf(await passages("tag:kept-tag"))).toEqual(["old"]);
    });
  });
});
