import { beforeEach, describe, expect, it, vi } from "vitest";

const searchChatsStreaming = vi.hoisted(() => vi.fn());
const safeSendMessage = vi.hoisted(() => vi.fn());

vi.mock("../src/services/syncService", () => ({ SyncService: { searchChatsStreaming } }));
vi.mock("../src/services/metadataRepository", () => ({ getMany: vi.fn(async () => new Map()) }));
vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  handleSearchChats,
  handleSearchChatsStreaming,
} from "../src/background/handlers/searchHandlers";

const rebuilding = { processed: 3, total: 10, percentage: 30 };

type StreamingOptions = { onComplete: (stats: Record<string, unknown>) => void };

beforeEach(() => {
  searchChatsStreaming.mockReset();
  safeSendMessage.mockReset();
});

describe("search handlers and a rebuilding index", () => {
  it("broadcasts the rebuild status with searchStreamingComplete", async () => {
    searchChatsStreaming.mockImplementation((_query: string, options: StreamingOptions) => {
      options.onComplete({
        totalResults: 0,
        chatsScanned: 0,
        durationMs: 1,
        wasLimited: false,
        indexRebuilding: rebuilding,
      });
      return { cancel: () => {} };
    });

    await handleSearchChatsStreaming(
      { action: "searchChatsStreaming", query: "pineapple" },
      () => {},
    );

    const complete = safeSendMessage.mock.calls
      .map(([event]) => event)
      .find((event) => event.action === "searchStreamingComplete");
    expect(complete).toMatchObject({ totalResults: 0, indexRebuilding: rebuilding });
  });

  it("answers a plain search with the rebuild status beside the empty results", async () => {
    searchChatsStreaming.mockImplementation((_query: string, options: StreamingOptions) => {
      options.onComplete({ totalResults: 0, indexRebuilding: rebuilding });
      return { cancel: () => {} };
    });

    const response = await new Promise((resolve) => {
      void handleSearchChats({ action: "searchChats", query: "pineapple" }, resolve);
    });

    expect(response).toEqual({ success: true, results: [], indexRebuilding: rebuilding });
  });

  it("leaves the status out when the search ran", async () => {
    searchChatsStreaming.mockImplementation((_query: string, options: StreamingOptions) => {
      options.onComplete({ totalResults: 0 });
      return { cancel: () => {} };
    });

    const response = await new Promise((resolve) => {
      void handleSearchChats({ action: "searchChats", query: "pineapple" }, resolve);
    });

    expect(response).toEqual({ success: true, results: [] });
  });
});
