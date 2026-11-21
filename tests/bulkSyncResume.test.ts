import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBulkSync,
  handleBulkSyncTick,
  resumeBulkSync,
  stopWaitingForWorker,
} from "../src/background/bulkSync/orchestrator";
import {
  addPendingHandoff,
  clearPendingHandoffs,
  getPendingHandoffs,
} from "../src/background/bulkSync/pendingHandoffs";
import { planResume } from "../src/background/bulkSync/stateManager";
import type { BulkSyncState } from "../src/background/bulkSync/types";
import { handleWorkerMessage } from "../src/background/bulkSync/workerHandler";
import {
  clearStaleOperationLocks,
  getActiveOperation,
  getBulkSyncState,
  setActiveOperation,
  setBulkSyncState,
} from "../src/background/state";
import { safeSendMessage } from "../src/background/utils/messageUtils";
import { createExtractionTab } from "../src/background/utils/tabUtils";
import { bulkSyncViewFor } from "../src/utils/bulkSyncView";

// HVN-124 and HVN-127: a bulk sync that the service worker's restart interrupted goes on, ends, and
// leaves no chat behind; and a report from the worker belongs to the run that asked for it.
// The tests put a run in the state the restart leaves (state, pending hand-offs, lock) and press
// the same two keys init.ts presses: clear the stale locks, resume.

const OLD_TAB = 42;
const NEW_TAB = 77;
const STARTED = 1_700_000_000_000;

type SyncRequest = { type: string; data: { chatId: string; runId: string } };

const { workerRequests, fetched, fetchErrors, workerMode } = vi.hoisted(() => ({
  workerRequests: [] as SyncRequest[],
  fetched: [] as string[],
  fetchErrors: new Map<string, string>(),
  // "report": the worker answers every sync request; "silent": it never does
  workerMode: { value: "report" as "report" | "silent" },
}));

vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: vi.fn(async (_worker: string, message: SyncRequest) => {
    workerRequests.push(message);
    if (message.type === "sync" && workerMode.value === "report") {
      const { chatId, runId } = message.data;
      // The worker's report arrives as its own message, after the request has returned
      setTimeout(() => {
        void handleWorkerMessage({
          type: "progress",
          chatId,
          runId,
          success: true,
          processed: 1,
          failed: 0,
          skipped: 0,
        });
      }, 0);
    }
    return undefined;
  }),
}));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: vi.fn(async () => undefined),
}));
vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: vi.fn() }));
vi.mock("../src/background/utils/tabUtils", () => ({ createExtractionTab: vi.fn() }));
vi.mock("../src/background/bulkSync/fetchStrategies", () => ({
  getStrategy: () => ({
    fetch: async ({ chatId }: { chatId: string }) => {
      fetched.push(chatId);
      const error = fetchErrors.get(chatId);
      return error ? { success: false, error } : { success: true, data: { conversation: {} } };
    },
  }),
}));
vi.mock("../src/providers/provider", () => ({
  getProvider: (name: string) => ({
    name,
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
    batchCheckExistingChats: vi.fn(async () => new Set<string>()),
  },
}));
vi.mock("../src/services/cacheService", () => ({ CacheService: {} }));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => undefined),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i + 1}`);

function runState(over: Partial<BulkSyncState>): BulkSyncState {
  return {
    status: "running",
    provider: "chatgpt",
    tabId: 0,
    extractionTabId: OLD_TAB,
    baseUrl: undefined,
    chatIds: [],
    total: 0,
    currentIndex: 0,
    isCancelled: false,
    failedSyncs: [],
    skippedCount: 0,
    platformName: "chatgpt",
    overwriteExisting: false,
    isProcessing: false,
    startedAt: STARTED,
    lastProgressAt: Date.now(),
    processedChatIds: [],
    ...over,
  };
}

/**
 * The state a restart leaves behind: a run of `n` chats whose first `handedOver` were handed to the
 * worker, of which `pending` had not been reported on. The lock is still taken.
 */
async function interruptedRun(opts: {
  n: number;
  handedOver: number;
  pending?: string[];
  failedSyncs?: BulkSyncState["failedSyncs"];
  over?: Partial<BulkSyncState>;
}): Promise<void> {
  const all = ids(opts.n);
  await setBulkSyncState(
    runState({
      chatIds: all,
      total: opts.n,
      currentIndex: opts.handedOver,
      processedChatIds: all.slice(0, opts.handedOver),
      failedSyncs: opts.failedSyncs ?? [],
      ...opts.over,
    }),
  );
  await setActiveOperation("bulkSync");
  await clearPendingHandoffs();
  for (const id of opts.pending ?? []) await addPendingHandoff(id);
}

/** What init.ts does at a service-worker start. */
async function restart(provider = "chatgpt"): Promise<void> {
  await clearStaleOperationLocks();
  await resumeBulkSync(provider);
}

/** Ticks until the run is over, as the alarm would. Bounded: a run that never ends stays in storage. */
async function driveToEnd(maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (!(await getBulkSyncState())) return;
    await handleBulkSyncTick();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sent(action: string) {
  return vi
    .mocked(safeSendMessage)
    .mock.calls.map(([m]) => m)
    .filter((m) => m.action === action);
}

beforeEach(async () => {
  workerRequests.length = 0;
  fetched.length = 0;
  fetchErrors.clear();
  workerMode.value = "report";
  vi.mocked(createExtractionTab).mockReset();
  vi.mocked(createExtractionTab).mockResolvedValue(NEW_TAB);
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn(async () => undefined), onMessage: { addListener: vi.fn() } },
    tabs: { get: vi.fn(async (id: number) => ({ id })), remove: vi.fn(async () => undefined) },
    alarms: { create: vi.fn(), clear: vi.fn() },
  });
  await setBulkSyncState(null);
  await setActiveOperation("idle");
  await clearPendingHandoffs();
});

afterEach(() => {
  stopWaitingForWorker();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a resumed run with fewer chats left than its total ends (HVN-124)", () => {
  it("finishes, closes its tab, wipes its state and frees the lock", async () => {
    // 7 of 10 handed over and reported on: 3 are left, and the run's total is still 10
    await interruptedRun({ n: 10, handedOver: 7 });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c8", "c9", "c10"]);
    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(NEW_TAB);
    expect(sent("bulkSyncComplete")).toHaveLength(1);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 10,
      successCount: 10,
      failedCount: 0,
    });
  });

  it("ends at once when every chat had been handed over and reported", async () => {
    await interruptedRun({ n: 4, handedOver: 4 });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual([]);
    expect(await getBulkSyncState()).toBeNull();
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(NEW_TAB);
    expect(sent("bulkSyncComplete")).toHaveLength(1);
  });

  it("ends a run that an earlier version resumed, and replaced chatIds of", async () => {
    // What the old resume left: only the chats still to do in chatIds, the run's total unchanged,
    // the settled ones in processedChatIds alone
    await setBulkSyncState(
      runState({
        chatIds: ["c9", "c10"],
        total: 10,
        currentIndex: 0,
        processedChatIds: ids(8),
      }),
    );
    await setActiveOperation("bulkSync");

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c9", "c10"]);
    expect(await getBulkSyncState()).toBeNull();
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ totalCount: 10, successCount: 10 });
  });

  it("reads honestly: never over 100 percent, never backwards while it runs", async () => {
    await interruptedRun({ n: 10, handedOver: 4 });
    const percents: number[] = [];
    const observe = async () => {
      const state = await getBulkSyncState();
      if (state) percents.push(bulkSyncViewFor(state, "chatgpt").percent);
    };

    await restart();
    await observe();
    for (let i = 0; i < 40 && (await getBulkSyncState()); i++) {
      await handleBulkSyncTick();
      await observe();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const shown = sent("bulkSyncProgress")
      .map((m) => m.progress as number)
      .filter((p) => typeof p === "number");
    expect(percents.length).toBeGreaterThan(0);
    for (const series of [percents, shown]) {
      expect(Math.max(...series)).toBeLessThanOrEqual(100);
      expect([...series].sort((a, b) => a - b)).toEqual(series);
    }
    // the first chat fetched after the resume is the 5th of 10
    expect(shown[0]).toBeCloseTo(50);
  });

  it("says the run's total in its started message", async () => {
    await interruptedRun({ n: 10, handedOver: 7 });

    await restart();
    await driveToEnd();

    expect(sent("bulkSyncStarted")[0]).toMatchObject({ total: 10 });
  });
});

describe("a chat handed to the worker before the restart is not lost (HVN-127)", () => {
  it("is fetched again, and so are the others the worker had not reported on", async () => {
    // c2 and c3 were handed over and not reported on; c1 was reported
    await interruptedRun({ n: 5, handedOver: 3, pending: ["c2", "c3"] });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c2", "c3", "c4", "c5"]);
    expect(await getBulkSyncState()).toBeNull();
    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 5,
      successCount: 5,
      failedCount: 0,
    });
    // each of the five chats ends up with one report from this stretch of the run
    const handedNow = workerRequests.filter((r) => r.type === "sync").map((r) => r.data.chatId);
    expect(handedNow).toEqual(["c2", "c3", "c4", "c5"]);
  });

  it("is fetched again with overwrite off too, and counted once (the worker may have saved it)", async () => {
    await interruptedRun({
      n: 3,
      handedOver: 3,
      pending: ["c3"],
      over: { overwriteExisting: false },
    });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c3"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 3,
      successCount: 3,
      failedCount: 0,
    });
  });

  it("fails with its reason when the second fetch fails, rather than vanishing", async () => {
    await interruptedRun({ n: 3, handedOver: 3, pending: ["c2"] });
    fetchErrors.set("c2", "the page said 404");

    await restart();
    await driveToEnd();

    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 3,
      successCount: 2,
      failedCount: 1,
    });
  });

  it("is not counted failed for a failure the worker reported just before the restart", async () => {
    // the report had landed in failedSyncs, and the service worker went before it settled the chat
    await interruptedRun({
      n: 3,
      handedOver: 3,
      pending: ["c2"],
      failedSyncs: [{ chatId: "c2", error: "download failed" }],
    });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c2"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 3, failedCount: 0 });
  });

  it("keeps a failure that was settled: that chat is not fetched again", async () => {
    await interruptedRun({
      n: 3,
      handedOver: 3,
      failedSyncs: [{ chatId: "c2", error: "download failed" }],
    });

    await restart();
    await driveToEnd();

    expect(fetched).toEqual([]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 2, failedCount: 1 });
  });

  it("does not wait for the old hand-offs: the new tab is the one its downloads use", async () => {
    await interruptedRun({ n: 3, handedOver: 3, pending: ["c3"] });

    await restart();

    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(OLD_TAB);
    const state = await getBulkSyncState();
    expect(state).toMatchObject({ extractionTabId: NEW_TAB, status: "running" });
    await driveToEnd();
  });

  it("owns every chat of the run: each is settled, failed or fetched again", async () => {
    // a mixed restart: reported ones, failed ones, pending ones, ones not yet fetched
    await interruptedRun({
      n: 9,
      handedOver: 6,
      pending: ["c4", "c6"],
      failedSyncs: [{ chatId: "c2", error: "boom" }],
    });
    fetchErrors.set("c6", "gone");

    await restart();
    await driveToEnd();

    const done = sent("bulkSyncComplete")[0];
    expect(done).toMatchObject({ totalCount: 9, failedCount: 2, successCount: 7 });
    expect(new Set(fetched)).toEqual(new Set(["c4", "c6", "c7", "c8", "c9"]));
  });
});

describe("a run that is resumed again after a second restart", () => {
  it("fetches again what the second leg had not settled", async () => {
    workerMode.value = "silent";
    await interruptedRun({ n: 6, handedOver: 2 });
    await restart();
    // first leg after the restart: c3..c6 are handed over, no report comes before the next restart
    expect((await getBulkSyncState())?.processedChatIds).toEqual(ids(6));
    expect((await getPendingHandoffs()).chatIds).toEqual(["c3", "c4", "c5", "c6"]);

    workerMode.value = "report";
    fetched.length = 0;
    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c3", "c4", "c5", "c6"]);
    expect(await getBulkSyncState()).toBeNull();
    expect(sent("bulkSyncComplete").at(-1)).toMatchObject({ totalCount: 6, failedCount: 0 });
  });
});

describe("the plan of a resume", () => {
  it("puts the settled chats first, the pending ones next, then the rest, and counts the whole list", () => {
    const plan = planResume(
      {
        chatIds: ids(6),
        processedChatIds: ["c1", "c2", "c3"],
        failedSyncs: [{ chatId: "c2", error: "x" }],
      },
      ["c2", "c9"],
    );

    expect(plan.chatIds).toEqual(["c1", "c3", "c2", "c4", "c5", "c6"]);
    expect(plan.processedChatIds).toEqual(["c1", "c3"]);
    expect(plan.currentIndex).toBe(2);
    expect(plan.total).toBe(6);
    expect(plan.failedSyncs).toEqual([]);
    expect(plan.refetched).toEqual(["c2"]);
  });

  it("is a no-op for a run with nothing pending", () => {
    const plan = planResume({ chatIds: ids(3), processedChatIds: ["c1"], failedSyncs: [] }, []);
    expect(plan).toMatchObject({ chatIds: ids(3), total: 3, currentIndex: 1, refetched: [] });
  });
});

describe("a report belongs to the run that asked for it (HVN-127)", () => {
  const progress = (chatId: string, runId: string, success = false) =>
    ({
      type: "progress",
      chatId,
      runId,
      success,
      error: success ? undefined : "download failed",
      processed: 0,
      failed: 1,
      skipped: 0,
    }) as const;

  async function runWithOneChatOut(resumeCount: number): Promise<BulkSyncState> {
    const state = runState({
      chatIds: ["c1", "c2"],
      total: 2,
      currentIndex: 2,
      processedChatIds: ["c1", "c2"],
      resumeCount,
    });
    await setBulkSyncState(state);
    await setActiveOperation("bulkSync");
    await addPendingHandoff("c2");
    return state;
  }

  it("ignores a late report from an earlier run: it neither settles nor fails the chat", async () => {
    const state = await runWithOneChatOut(0);

    await handleWorkerMessage(progress("c2", `${STARTED - 5000}:0`));

    expect((await getBulkSyncState())?.failedSyncs).toEqual([]);
    expect((await getPendingHandoffs()).chatIds).toEqual(["c2"]);
    expect((await getBulkSyncState())?.startedAt).toBe(state.startedAt);
    expect(sent("bulkSyncComplete")).toHaveLength(0);
  });

  it("ignores a late success from an earlier run too: the tab stays for the chat still out", async () => {
    await runWithOneChatOut(0);

    await handleWorkerMessage(progress("c2", `${STARTED - 5000}:0`, true));

    expect((await getPendingHandoffs()).chatIds).toEqual(["c2"]);
    expect(await getBulkSyncState()).not.toBeNull();
    expect(vi.mocked(chrome.tabs.remove)).not.toHaveBeenCalled();
  });

  it("ignores a report from before the restart that the resume redid", async () => {
    await runWithOneChatOut(1);

    await handleWorkerMessage(progress("c2", `${STARTED}:0`));

    expect((await getBulkSyncState())?.failedSyncs).toEqual([]);
    expect((await getPendingHandoffs()).chatIds).toEqual(["c2"]);
  });

  it("ignores a report that carries no run at all", async () => {
    await runWithOneChatOut(0);

    await handleWorkerMessage({ ...progress("c2", ""), runId: undefined as unknown as string });

    expect((await getBulkSyncState())?.failedSyncs).toEqual([]);
    expect((await getPendingHandoffs()).chatIds).toEqual(["c2"]);
  });

  it("counts the run's own report: a failure is recorded and the last chat ends the run", async () => {
    await runWithOneChatOut(1);

    await handleWorkerMessage(progress("c2", `${STARTED}:1`));

    expect(await getBulkSyncState()).toBeNull();
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ failedCount: 1, successCount: 1 });
  });

  it("asks the worker with the run's id, and a resumed run's differs from its first stretch", async () => {
    await interruptedRun({ n: 3, handedOver: 1 });

    await restart();
    await driveToEnd();

    const ids = workerRequests.filter((r) => r.type === "sync").map((r) => r.data.runId);
    expect(ids).toEqual([`${STARTED}:1`, `${STARTED}:1`]);
  });

  it("a cleanup for the run that ended does not wipe the run that began", async () => {
    // the ownership rule of HVN-126, still in force beside the report's id
    await interruptedRun({ n: 2, handedOver: 2 });
    const earlier = (await getBulkSyncState()) as BulkSyncState;
    await setBulkSyncState({ ...earlier, startedAt: STARTED + 10 });

    await cleanupBulkSync(earlier);

    expect((await getBulkSyncState())?.startedAt).toBe(STARTED + 10);
  });
});
