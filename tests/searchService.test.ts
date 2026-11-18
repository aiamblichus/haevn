import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, SearchResult } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";
import type { SearchWorkerMessage } from "../src/types/workerMessages";

const sendWorkerRequest = vi.hoisted(() => vi.fn());

vi.mock("../src/utils/workerApi", () => ({ sendWorkerRequest }));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: vi.fn(async () => {}),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { SearchService } from "../src/services/searchService";

type Chunk = {
  type: "searchResultChunk";
  requestId: string;
  results: SearchResult[];
  done: boolean;
  indexRebuilding?: { processed: number; total: number; percentage: number };
  indexIncomplete?: { error: string };
};

/** Make the worker answer a streaming search with these chunks. */
function workerAnswers(chunks: Array<Partial<Chunk>>): void {
  sendWorkerRequest.mockImplementation(
    async (
      _worker: string,
      message: SearchWorkerMessage,
      options: { onProgress: (chunk: Chunk) => void },
    ) => {
      const requestId = (message as { requestId: string }).requestId;
      for (const chunk of chunks) {
        options.onProgress({
          type: "searchResultChunk",
          requestId,
          results: [],
          done: true,
          ...chunk,
        });
      }
    },
  );
}

function runSearch(): Promise<{ results: SearchResult[]; stats: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const results: SearchResult[] = [];
    SearchService.searchChatsStreaming("pineapple", {
      onResults: (batch) => results.push(...batch),
      onComplete: (stats) => resolve({ results, stats }),
      onError: reject,
    });
  });
}

beforeEach(() => {
  sendWorkerRequest.mockReset();
});

describe("SearchService.searchChatsStreaming and a rebuilding index", () => {
  it("completes with the rebuild status, so zero results is not read as no matches", async () => {
    const status = { processed: 40, total: 100, percentage: 40 };
    workerAnswers([{ results: [], done: true, indexRebuilding: status }]);

    const { results, stats } = await runSearch();

    expect(results).toEqual([]);
    expect(stats.totalResults).toBe(0);
    expect(stats.indexRebuilding).toEqual(status);
  });

  it("carries no status when the search ran", async () => {
    const hit = { chatId: "c1", messageId: "m1" } as SearchResult;
    workerAnswers([{ results: [hit], done: true }]);

    const { results, stats } = await runSearch();

    expect(results).toEqual([hit]);
    expect(stats).not.toHaveProperty("indexRebuilding");
  });
});

describe("SearchService.searchChatsStreaming and an index left part-built by a failed rebuild", () => {
  it("completes with the failure, also when the search found chats", async () => {
    const hit = { chatId: "c1", messageId: "m1" } as SearchResult;
    const incomplete = { error: "boom" };
    workerAnswers([{ results: [hit], done: true, indexIncomplete: incomplete }]);

    const { results, stats } = await runSearch();

    expect(results).toEqual([hit]);
    expect(stats.indexIncomplete).toEqual(incomplete);
    expect(stats).not.toHaveProperty("indexRebuilding");
  });

  it("carries no failure when the worker sent none", async () => {
    workerAnswers([{ results: [], done: true }]);

    const { stats } = await runSearch();

    expect(stats).not.toHaveProperty("indexIncomplete");
  });
});

describe("SearchService.searchChatsStreaming and the limit (HVN-77)", () => {
  const hit = (chatId: string, messageId: string) => ({ chatId, messageId }) as SearchResult;

  function runWith(
    options: Record<string, unknown> = {},
  ): Promise<{ results: SearchResult[]; stats: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const results: SearchResult[] = [];
      SearchService.searchChatsStreaming("pineapple", {
        onResults: (batch) => results.push(...batch),
        onComplete: (stats) => resolve({ results, stats }),
        onError: reject,
        ...options,
      });
    });
  }

  it("asks the worker for that many chats and passages, and for the filters", async () => {
    workerAnswers([{ results: [], done: true }]);
    const filters = { after: 1000, category: "code" };

    await runWith({ maxChatsToScan: 7, resultsPerChat: 4, filters });

    expect(sendWorkerRequest.mock.calls[0][1]).toMatchObject({
      type: "search",
      maxChats: 7,
      passagesPerChat: 4,
      filters,
    });
  });

  it("completes with wasLimited when the worker says more chats matched", async () => {
    workerAnswers([{ results: [hit("c1", "m1")], done: true, wasLimited: true }]);

    expect((await runWith()).stats.wasLimited).toBe(true);
  });

  it("completes with wasLimited false when the worker says nothing was cut", async () => {
    workerAnswers([{ results: [hit("c1", "m1")], done: true, wasLimited: false }]);

    expect((await runWith()).stats.wasLimited).toBe(false);
  });

  it("counts the chats of the results, not the passages", async () => {
    workerAnswers([
      { results: [hit("c1", "m1"), hit("c1", "m2")], done: false },
      { results: [hit("c1", "m3"), hit("c2", "m1")], done: true },
    ]);

    const { stats } = await runWith();

    expect(stats).toMatchObject({ totalResults: 4, chatsScanned: 2 });
  });
});

describe("SearchService.searchChatsStreaming for an id, with a limit and filters (HVN-77)", () => {
  const chatRow = (id: string, timestamp: number) =>
    ({ id, source: "test", title: id, timestamp, deleted: 0 }) as unknown as Chat;

  async function seed(...rows: Chat[]): Promise<void> {
    const db = getDB();
    await Promise.all([db.chats.clear(), db.chatMetadata.clear()]);
    await db.chats.bulkPut(rows);
  }

  function runId(
    options: Record<string, unknown>,
  ): Promise<{ results: SearchResult[]; stats: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const results: SearchResult[] = [];
      SearchService.searchChatsStreaming("id:abc", {
        onResults: (batch) => results.push(...batch),
        onComplete: (stats) => resolve({ results, stats }),
        onError: reject,
        ...options,
      });
    });
  }

  it("says it was limited only when more chats had the prefix than the limit", async () => {
    await seed(chatRow("abc1", 1), chatRow("abc2", 1), chatRow("abc3", 1));

    const exact = await runId({ maxChatsToScan: 3 });
    const cut = await runId({ maxChatsToScan: 2 });

    expect(exact.results).toHaveLength(3);
    expect(exact.stats.wasLimited).toBe(false);
    expect(cut.results).toHaveLength(2);
    expect(cut.stats.wasLimited).toBe(true);
  });

  it("applies the date range and the category before the limit", async () => {
    await seed(chatRow("abc1", 10), chatRow("abc2", 20), chatRow("abc3", 30));
    await getDB().chatMetadata.put({
      chatId: "abc3",
      title: "",
      description: "",
      synopsis: "",
      categories: ["code"],
      keywords: [],
      source: "manual",
      updatedAt: 1,
    });

    const dated = await runId({ maxChatsToScan: 1, filters: { after: 25 } });
    const categorised = await runId({ maxChatsToScan: 1, filters: { category: "code" } });

    expect(dated.results.map((r) => r.chatId)).toEqual(["abc3"]);
    expect(dated.stats.wasLimited).toBe(false);
    expect(categorised.results.map((r) => r.chatId)).toEqual(["abc3"]);
    expect(categorised.stats.wasLimited).toBe(false);
  });
});
