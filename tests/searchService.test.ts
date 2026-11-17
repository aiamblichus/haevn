import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "../src/model/haevn_model";
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
