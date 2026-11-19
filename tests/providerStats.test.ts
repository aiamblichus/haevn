import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { CacheService } from "../src/services/cacheService";
import { getDB } from "../src/services/db";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/background/utils/messageUtils", () => ({
  safeSendMessage: vi.fn(() => undefined),
}));

vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: async () => undefined,
}));

// No stats worker answers in these tests, so a recalculation takes its direct fallback, which is
// the same count the worker makes.
const workerCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: async () => {
    workerCalls.count += 1;
    throw new Error("no stats worker in this test");
  },
}));

const CLAUDE_KEY = "provider-count:claude";
const STALE_MS = 10 * 60 * 1000; // past the five-minute provider-count window

function buildChat(id: string, source: string, deleted: 0 | 1): Chat {
  return {
    id,
    source,
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["test-model"],
    system: undefined,
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "synced",
    lastSyncAttemptMessage: undefined,
    deleted,
  };
}

/** Two live claude chats and one soft-deleted claude chat, and a live codex chat. */
async function seedArchive(): Promise<void> {
  await getDB().chats.bulkAdd([
    buildChat("c1", "claude", 0),
    buildChat("c2", "claude", 0),
    buildChat("c3", "claude", 1),
    buildChat("x1", "codex", 0),
  ]);
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.cache.clear()]);
  workerCalls.count = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type Posted = { type: string; requestId?: string; [key: string]: unknown };

/** The stats worker, with its message handler installed and its replies collected. */
async function loadStatsWorker() {
  vi.resetModules();
  const posted: Posted[] = [];
  const workerSelf = { postMessage: (message: Posted) => void posted.push(message) };
  vi.stubGlobal("self", workerSelf);
  await import("../src/services/stats.worker");
  const onmessage = (workerSelf as { onmessage?: (event: { data: unknown }) => Promise<void> })
    .onmessage;
  if (!onmessage) throw new Error("the stats worker did not install onmessage");
  return {
    posted,
    send: (message: Record<string, unknown>) => onmessage({ data: message }),
  };
}

describe("the stats worker counts live chats (HVN-85)", () => {
  it("answers a provider's count without its soft-deleted chats", async () => {
    await seedArchive();
    const worker = await loadStatsWorker();

    await worker.send({ type: "getProviderStats", providerName: "claude", requestId: "r1" });

    expect(worker.posted).toContainEqual({
      type: "providerStatsResult",
      requestId: "r1",
      count: 2,
    });
  });

  it("answers 0 for a provider whose chats are all soft-deleted", async () => {
    await getDB().chats.bulkAdd([buildChat("g1", "gemini", 1)]);
    const worker = await loadStatsWorker();

    await worker.send({ type: "getProviderStats", providerName: "gemini", requestId: "r2" });

    expect(worker.posted).toContainEqual({
      type: "providerStatsResult",
      requestId: "r2",
      count: 0,
    });
  });
});

describe("the provider count while the cache recalculates (HVN-85)", () => {
  it("recalculates to the live count, not the count with soft-deleted chats", async () => {
    await seedArchive();

    const count = await CacheService.recalculateProviderStats("claude");

    expect(count).toBe(2);
    expect((await getDB().cache.get(CLAUDE_KEY))?.value).toBe(2);
  });

  it("answers the last known count while a stale cache recalculates, not 0", async () => {
    await seedArchive();
    await getDB().cache.put({
      id: CLAUDE_KEY,
      value: 3,
      lastUpdated: Date.now() - STALE_MS,
      expiresAt: undefined,
    });

    const answer = await CacheService.getProviderStats("claude");

    expect(answer).toBe(3);
    // The recalculation then replaces the stale 3 with the live count.
    await vi.waitFor(async () => expect((await getDB().cache.get(CLAUDE_KEY))?.value).toBe(2));
  });

  it("answers 0 when no count was ever cached, and fills the cache in the background", async () => {
    await seedArchive();

    expect(await CacheService.getProviderStats("claude")).toBe(0);

    await vi.waitFor(async () => expect((await getDB().cache.get(CLAUDE_KEY))?.value).toBe(2));
  });

  it("answers a fresh cached count without recalculating", async () => {
    await seedArchive();
    await getDB().cache.put({
      id: CLAUDE_KEY,
      value: 5,
      lastUpdated: Date.now(),
      expiresAt: undefined,
    });

    expect(await CacheService.getProviderStats("claude")).toBe(5);
    // Give a recalculation that should not have started the chance to call the worker.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(workerCalls.count).toBe(0);
    expect((await getDB().cache.get(CLAUDE_KEY))?.value).toBe(5);
  });
});
