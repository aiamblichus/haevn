import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage, SearchResult } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

    // 120 chats is one 1000-chat chunk: the old counter would only ever read 0.
    expect([...processedSeen].some((n) => n > 0)).toBe(true);
  });
});
