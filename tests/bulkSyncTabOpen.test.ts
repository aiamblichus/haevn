import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleBulkSyncTick,
  stopWaitingForWorker,
  WORKER_IDLE_GIVE_UP_MS,
} from "../src/background/bulkSync/orchestrator";
import {
  clearPendingHandoffs,
  noteWorkerActivity,
} from "../src/background/bulkSync/pendingHandoffs";
import type { BulkSyncState } from "../src/background/bulkSync/types";
import { handleWorkerMessage } from "../src/background/bulkSync/workerHandler";
import { getBulkSyncState, setBulkSyncState } from "../src/background/state";
import { safeSendMessage } from "../src/background/utils/messageUtils";
import { log } from "../src/utils/logger";

// HVN-123: the bulk sync worker's transform downloads a chat's media through the extraction tab,
// so the tab must stay open until the worker has reported on every chat handed to it. The
// orchestrator used to wait a fixed 2 s after the last hand-off and then close it, which cut the
// last chat's downloads short: the chat saved, with fallbacks for its images.

const TAB = 42;

type WorkerRequest = { type: string; data?: { chatId: string; runId: string } };
const { workerRequests } = vi.hoisted(() => ({ workerRequests: [] as WorkerRequest[] }));

vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: vi.fn(async (_worker: string, message: WorkerRequest) => {
    workerRequests.push(message);
    return undefined;
  }),
}));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: vi.fn(async () => undefined),
}));
vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: vi.fn() }));
vi.mock("../src/background/utils/tabUtils", () => ({ createExtractionTab: vi.fn() }));
vi.mock("../src/background/bulkSync/fetchStrategies", () => ({
  getStrategy: () => ({ fetch: async () => ({ success: true, data: { conversation: {} } }) }),
}));
vi.mock("../src/providers/provider", () => ({
  getProvider: () => ({
    name: "chatgpt",
    bulkSyncConfig: { mode: "api", rateLimitDelayMs: 0 },
    getListUrl: () => "https://chatgpt.com/",
    buildChatUrl: (id: string) => `https://chatgpt.com/c/${id}`,
  }),
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: {
    finishBulkSyncIndexing: vi.fn(async () => undefined),
    startBulkSyncIndexing: vi.fn(async () => undefined),
    addOrUpdateChatInIndex: vi.fn(async () => undefined),
  },
}));
vi.mock("../src/services/cacheService", () => ({ CacheService: {} }));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => undefined),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let removed: number[];

function runningState(chatIds: string[]): BulkSyncState {
  return {
    status: "running",
    provider: "chatgpt",
    tabId: 0,
    extractionTabId: TAB,
    chatIds,
    total: chatIds.length,
    currentIndex: 0,
    isCancelled: false,
    failedSyncs: [],
    skippedCount: 0,
    platformName: "chatgpt",
    overwriteExisting: false,
    isProcessing: false,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    processedChatIds: [],
  };
}

// The worker echoes the run id of the request it is answering (HVN-127)
function report(chatId: string, success = true) {
  const request = workerRequests.findLast((m) => m.type === "sync" && m.data?.chatId === chatId);
  return handleWorkerMessage({
    type: "progress",
    chatId,
    runId: request?.data?.runId,
    success,
    savedIds: success ? [chatId] : undefined,
    error: success ? undefined : "boom",
    processed: 1,
    failed: 0,
    skipped: 0,
  } as never);
}

// The worker's last message is remembered in the module, across tests: each test starts a day later
// than the last, so that memory is always from the past.
let clock = Date.UTC(2026, 10, 21);

beforeEach(async () => {
  clock += 24 * 60 * 60 * 1000;
  vi.useFakeTimers({ now: clock });
  removed = [];
  workerRequests.length = 0;
  vi.stubGlobal("chrome", {
    ...(globalThis as { chrome: object }).chrome,
    tabs: {
      get: vi.fn(async () => ({ id: TAB })),
      remove: vi.fn(async (id: number) => {
        removed.push(id);
      }),
    },
    alarms: { create: vi.fn(), clear: vi.fn() },
  });
  await setBulkSyncState(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function startAndHandOver(chatIds: string[]) {
  await setBulkSyncState(runningState(chatIds));
  // the tick pauses between chats (the politeness delay); the clock is the test's
  const tick = handleBulkSyncTick();
  await vi.advanceTimersByTimeAsync(1000);
  await tick;
  expect(workerRequests.filter((m) => m.type === "sync")).toHaveLength(chatIds.length);
}

describe("the extraction tab stays open while the worker is still on a chat", () => {
  it("keeps it open past the old 2 s wait, and closes it when the worker reports", async () => {
    await startAndHandOver(["c1"]);

    // a slow transform: a long time passes with no report
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removed).toEqual([]);
    expect(await getBulkSyncState()).not.toBeNull();

    await report("c1");

    expect(removed).toEqual([TAB]);
    expect(await getBulkSyncState()).toBeNull();
    // the worker was reset only after it had finished
    expect(workerRequests.at(-1)).toEqual({ type: "reset" });
  });

  it("waits for the last of several chats, whatever order they report in", async () => {
    await startAndHandOver(["c1", "c2", "c3"]);
    await vi.advanceTimersByTimeAsync(10_000);

    await report("c2");
    await report("c3", false);
    expect(removed).toEqual([]);
    // a chat the worker failed on is recorded, as before
    expect((await getBulkSyncState())?.failedSyncs).toEqual([{ chatId: "c3", error: "boom" }]);

    await report("c1");
    expect(removed).toEqual([TAB]);
  });

  it("does not wait when nothing was handed over", async () => {
    await setBulkSyncState({ ...runningState([]), total: 0 });

    await handleBulkSyncTick();

    expect(removed).toEqual([TAB]);
  });
});

describe("a worker that never reports does not hold the sync forever", () => {
  it("gives up after the worker has been silent for the bound, and says so", async () => {
    await startAndHandOver(["c1"]);

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_GIVE_UP_MS - 10_000);
    expect(removed).toEqual([]);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(removed).toEqual([TAB]);
    expect(await getBulkSyncState()).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Giving up on the worker"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("c1"));
    // the chat that never reported is counted as failed, not as synced
    const sent = JSON.stringify(vi.mocked(safeSendMessage).mock.calls);
    expect(sent).toContain("1 failed");
  });

  it("remembers the worker's last sign of life across a service-worker restart", async () => {
    await startAndHandOver(["c1"]);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    noteWorkerActivity(); // the worker asked for a download at +2 min
    await vi.advanceTimersByTimeAsync(20_000);
    expect(removed).toEqual([]);

    // restart: the module's memory is gone, storage is not
    const adapter = (await import("../src/storage")).getStorageAdapter();
    vi.resetModules();
    (await import("../src/storage")).setStorageAdapter(adapter);
    const fresh = await import("../src/background/bulkSync/orchestrator");

    // 3 min 30 s after the hand-off, 90 s after the worker last spoke: still waiting
    await vi.advanceTimersByTimeAsync(70_000);
    await fresh.handleBulkSyncTick();
    expect(removed).toEqual([]);
  });
});

describe("a stale wait does not touch the next run", () => {
  it("a force-reset run's recheck does not close the next run's tab", async () => {
    await startAndHandOver(["c1"]); // run A waits, its recheck armed

    // force-reset (as handleForceResetBulkSync does), then run B starts straight away
    await setBulkSyncState(null);
    stopWaitingForWorker();
    await clearPendingHandoffs();
    await setBulkSyncState({ ...runningState(["b1", "b2", "b3"]), extractionTabId: 77 });

    await vi.advanceTimersByTimeAsync(6000);

    expect(removed).toEqual([]);
    expect((await getBulkSyncState())?.status).toBe("running");
  });

  it("even without the reset's stop, a recheck leaves a run that is still handing over alone", async () => {
    await startAndHandOver(["c1"]);

    // run B starts (startBulkSync clears the pending set) while A's recheck is still armed
    await setBulkSyncState(null);
    await clearPendingHandoffs();
    await setBulkSyncState({ ...runningState(["b1", "b2", "b3"]), extractionTabId: 77 });
    await vi.advanceTimersByTimeAsync(6000);

    expect(removed).toEqual([]);
    expect((await getBulkSyncState())?.currentIndex).toBe(0);
  });

  it("counts from the worker's last sign of life, not from the hand-off", async () => {
    await startAndHandOver(["c1"]);

    // the worker keeps asking for downloads without reporting: busy, not dead
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(WORKER_IDLE_GIVE_UP_MS / 2);
      noteWorkerActivity();
    }
    expect(removed).toEqual([]);

    await vi.advanceTimersByTimeAsync(WORKER_IDLE_GIVE_UP_MS + 10_000);
    expect(removed).toEqual([TAB]);
  });
});
