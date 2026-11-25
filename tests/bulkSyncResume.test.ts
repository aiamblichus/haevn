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
  settlePendingHandoff,
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
import { getStorageAdapter } from "../src/storage";
import { bulkSyncViewFor } from "../src/utils/bulkSyncView";

// HVN-124 and HVN-127: a bulk sync that the service worker's restart interrupted goes on, ends, and
// leaves no chat behind; and a report from the worker belongs to the run that asked for it.
// The tests put a run in the state the restart leaves (state, pending hand-offs, lock) and press
// the same two keys init.ts presses: clear the stale locks, resume.

const OLD_TAB = 42;
const NEW_TAB = 77;
const STARTED = 1_700_000_000_000;

type SyncRequest = { type: string; data: { chatId: string; runId: string } };

const { workerRequests, fetched, fetchErrors, workerMode, fetchHold, workerHold, rate } =
  vi.hoisted(() => ({
    workerRequests: [] as SyncRequest[],
    fetched: [] as string[],
    fetchErrors: new Map<string, string>(),
    // a test sets a promise here to hold the next fetch open (it may reject, as a closed tab does)
    fetchHold: { promise: null as Promise<void> | null },
    // the provider's politeness delay between two chats, in ms
    rate: { ms: 0 },
    // the same for the hand-off to the worker
    workerHold: { promise: null as Promise<void> | null },
    // "report": the worker answers every sync request; "silent": it never does
    workerMode: { value: "report" as "report" | "silent" },
  }));

vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: vi.fn(async (_worker: string, message: SyncRequest) => {
    workerRequests.push(message);
    const hold = workerHold.promise;
    if (message.type === "sync" && hold) {
      workerHold.promise = null;
      await hold;
    }
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
      const hold = fetchHold.promise;
      fetchHold.promise = null;
      if (hold) await hold;
      const error = fetchErrors.get(chatId);
      return error ? { success: false, error } : { success: true, data: { conversation: {} } };
    },
  }),
}));
vi.mock("../src/providers/provider", () => ({
  getProvider: (name: string) => ({
    name,
    bulkSyncConfig: { mode: "api", rateLimitDelayMs: rate.ms },
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
  fetchHold.promise = null;
  workerHold.promise = null;
  rate.ms = 0;
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

describe("a tick that began before the resume does not write over it (HVN-127)", () => {
  // The alarm wakes the service worker and starts a tick on the old state; the resume, started by
  // init.ts in the same context, rewrites the list and the index while that tick is on a chat.
  async function tickOnChatC4WhileResumeWrites(settle: "report" | "tab closed") {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    let release!: () => void;
    let fail!: (error: Error) => void;
    fetchHold.promise = new Promise<void>((resolve, reject) => {
      release = resolve;
      fail = reject;
    });
    const stale = handleBulkSyncTick();
    await vi.waitFor(() => expect(fetched).toEqual(["c4"]));

    await restart();
    if (settle === "report") release();
    else fail(new Error("No tab with id: 42."));
    await stale;
  }

  it("does not move the index: the chats the resume put back are still fetched again", async () => {
    await tickOnChatC4WhileResumeWrites("report");

    // the resume's own list: c1 settled, then c2 and c3 to do again; the stale tick wrote nothing
    expect((await getBulkSyncState())?.currentIndex).toBe(1);
    await driveToEnd();

    expect(fetched).toEqual(["c4", "c2", "c3", "c4", "c5", "c6"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 6,
      successCount: 6,
      failedCount: 0,
    });
  });

  it("does not record a failure for a chat the resume owns", async () => {
    await tickOnChatC4WhileResumeWrites("tab closed");

    expect((await getBulkSyncState())?.failedSyncs).toEqual([]);
    await driveToEnd();

    expect(fetched).toEqual(["c4", "c2", "c3", "c4", "c5", "c6"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 6, failedCount: 0 });
  });

  it("leaves no hand-off for the old run in the resumed run's pending set", async () => {
    await tickOnChatC4WhileResumeWrites("report");

    expect((await getPendingHandoffs()).chatIds).not.toContain("c4");
    expect(workerRequests.filter((r) => r.type === "sync" && r.data.runId.endsWith(":0"))).toEqual(
      [],
    );
  });
});

describe("a run that was stopped while it resumed stays stopped (HVN-126)", () => {
  async function resumeWhile(duringTabOpen: () => Promise<void>) {
    await interruptedRun({ n: 4, handedOver: 2 });
    let openTab!: (id: number) => void;
    vi.mocked(createExtractionTab).mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          openTab = resolve;
        }),
    );
    await clearStaleOperationLocks();
    const resuming = resumeBulkSync("chatgpt");
    await vi.waitFor(() => expect(createExtractionTab).toHaveBeenCalled());
    await duringTabOpen();
    openTab(NEW_TAB);
    await resuming;
  }

  it("is not revived when a Stop wiped it: the new tab is closed and nothing starts", async () => {
    await resumeWhile(async () => {
      await setBulkSyncState(null);
      await setActiveOperation("idle");
    });

    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(NEW_TAB);
    expect(vi.mocked(chrome.alarms.create)).not.toHaveBeenCalled();
    expect(sent("bulkSyncStarted")).toHaveLength(0);
    expect(fetched).toEqual([]);
  });

  it("is not resumed over a Stop that has marked it cancelled and not yet wiped it", async () => {
    await resumeWhile(async () => {
      const state = (await getBulkSyncState()) as BulkSyncState;
      await setBulkSyncState({ ...state, status: "cancelled", isCancelled: true });
    });

    expect((await getBulkSyncState())?.status).toBe("cancelled");
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(NEW_TAB);
    expect(vi.mocked(chrome.alarms.create)).not.toHaveBeenCalled();
    expect(sent("bulkSyncStarted")).toHaveLength(0);
    expect(fetched).toEqual([]);
  });

  it("does not overwrite a run that replaced it, nor free that run's lock", async () => {
    const newer = runState({ startedAt: STARTED + 50, chatIds: ["x1"], total: 1 });
    await resumeWhile(async () => {
      await setBulkSyncState(newer);
    });

    expect(await getBulkSyncState()).toEqual(newer);
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(NEW_TAB);
    expect(vi.mocked(chrome.tabs.remove)).not.toHaveBeenCalledWith(OLD_TAB);
    expect(fetched).toEqual([]);
  });
});

describe("a resume that lands later in the tick is not written over either (HVN-127)", () => {
  // The same stale tick as above, with the resume landing at each later step of its chat: the tick
  // reads the state before it writes, and each read is a place where the resume may have come between.
  const AGAIN = ["c2", "c3", "c4", "c5", "c6"];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function finishesWithAllSix() {
    await driveToEnd();
    expect(sent("bulkSyncComplete")[0]).toMatchObject({
      totalCount: 6,
      successCount: 6,
      failedCount: 0,
    });
  }

  it("before the chat is fetched: the tick leaves without fetching it", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async (id: number) => {
      await restart();
      return { id } as chrome.tabs.Tab;
    });

    await handleBulkSyncTick();

    expect(fetched).toEqual([]);
    expect((await getBulkSyncState())?.currentIndex).toBe(1);
    await finishesWithAllSix();
    expect(fetched).toEqual(AGAIN);
  });

  it("while the chat is being handed to the worker: it is not recorded as settled", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    let release!: () => void;
    workerHold.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = handleBulkSyncTick();
    await vi.waitFor(() => expect(workerRequests.some((r) => r.type === "sync")).toBe(true));

    await restart();
    release();
    await stale;

    const state = await getBulkSyncState();
    expect(state?.processedChatIds).toEqual(["c1"]);
    expect(state?.currentIndex).toBe(1);
    await finishesWithAllSix();
  });

  it("after the chat is recorded as settled: the tick does not move the index", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    const adapter = getStorageAdapter();
    const set = adapter.set.bind(adapter);
    let landed = false;
    vi.spyOn(adapter, "set").mockImplementation(async (key: string, value: unknown) => {
      await set(key, value);
      const written = value as BulkSyncState | null;
      if (!landed && key === "bulkSyncState" && written?.processedChatIds?.includes("c4")) {
        landed = true;
        await restart();
      }
    });

    await handleBulkSyncTick();

    expect(landed).toBe(true);
    expect((await getBulkSyncState())?.currentIndex).toBe(1);
  });
});

describe("a tick that recovers its tab does not write the earlier run over the resume (HVN-127)", () => {
  const RECOVERED_TAB = 88;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("closes the tab it opened and leaves the resume's list, index, count and tab alone", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    // the resume's tab, then the one the stale tick makes while it recovers
    vi.mocked(createExtractionTab)
      .mockResolvedValueOnce(NEW_TAB)
      .mockResolvedValueOnce(RECOVERED_TAB);
    // the resume lands while the tick is looking at its tab, and the tab it looked for is gone
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
      await restart();
      throw new Error("No tab with id: 42.");
    });

    await handleBulkSyncTick();

    expect(await getBulkSyncState()).toMatchObject({
      resumeCount: 1,
      currentIndex: 1,
      extractionTabId: NEW_TAB,
      processedChatIds: ["c1"],
    });
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(RECOVERED_TAB);
    expect(vi.mocked(chrome.tabs.remove)).not.toHaveBeenCalledWith(NEW_TAB);
    await driveToEnd();
    expect(fetched).toEqual(["c2", "c3", "c4", "c5", "c6"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 6, failedCount: 0 });
  });

  it("leaves the resume alone when it lands while the old tab is being closed", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    vi.mocked(createExtractionTab)
      .mockResolvedValueOnce(RECOVERED_TAB)
      .mockResolvedValueOnce(NEW_TAB);
    // the tick's tab is gone; the resume lands while the recovery closes it (Gauge N5)
    vi.mocked(chrome.tabs.get).mockImplementationOnce(async () => {
      throw new Error("No tab with id: 42.");
    });
    vi.mocked(chrome.tabs.remove).mockImplementationOnce(async () => {
      await restart();
    });

    await handleBulkSyncTick();

    expect(await getBulkSyncState()).toMatchObject({
      resumeCount: 1,
      currentIndex: 1,
      extractionTabId: NEW_TAB,
    });
    expect(vi.mocked(chrome.tabs.remove)).toHaveBeenCalledWith(RECOVERED_TAB);
  });

  it("keeps what a report wrote to the run while its new tab was opening", async () => {
    // an ordinary recovery, no resume: the tab was closed by someone, and the worker reports a failure meanwhile
    await interruptedRun({ n: 3, handedOver: 0 });
    let openTab!: (id: number) => void;
    vi.mocked(createExtractionTab).mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          openTab = resolve;
        }),
    );
    vi.mocked(chrome.tabs.get).mockRejectedValueOnce(new Error("No tab with id: 42."));
    const tick = handleBulkSyncTick();
    await vi.waitFor(() => expect(createExtractionTab).toHaveBeenCalled());

    const state = (await getBulkSyncState()) as BulkSyncState;
    await setBulkSyncState({ ...state, failedSyncs: [{ chatId: "c0", error: "boom" }] });
    openTab(RECOVERED_TAB);
    await tick;

    expect((await getBulkSyncState())?.failedSyncs).toEqual([{ chatId: "c0", error: "boom" }]);
    expect((await getBulkSyncState())?.extractionTabId).toBe(RECOVERED_TAB);
    await driveToEnd();
  });

  it("goes no further after the politeness delay when a resume landed in it", async () => {
    rate.ms = 300;
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    // as in Chrome: the tab the resume closed is gone
    vi.mocked(chrome.tabs.get).mockImplementation(async (id: number) => {
      const closed = vi.mocked(chrome.tabs.remove).mock.calls.some(([closedId]) => closedId === id);
      if (closed) throw new Error(`No tab with id: ${id}.`);
      return { id } as chrome.tabs.Tab;
    });
    const stale = handleBulkSyncTick();
    // c4 is fetched, handed over and reported on; the tick is now in its delay before c5
    await vi.waitFor(async () => {
      expect((await getBulkSyncState())?.currentIndex).toBe(4);
      expect((await getPendingHandoffs()).chatIds).toEqual(["c2", "c3"]);
    });

    await restart();
    await stale;

    // the tick did not go on from the list it read before the delay: no fetch, and no tab of its own
    expect(fetched).toEqual(["c4"]);
    expect(vi.mocked(createExtractionTab)).toHaveBeenCalledTimes(1);
    expect((await getBulkSyncState())?.currentIndex).toBe(2);
    rate.ms = 0;
    await driveToEnd();
    expect(fetched).toEqual(["c4", "c2", "c3", "c5", "c6"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 6, failedCount: 0 });
  });
});

describe("a tick that was skipped is not lost (HVN-127)", () => {
  /** The alarm, and nothing else: a tick runs only when the last one (or the resume) set it. */
  async function runWhileAlarmArmed(maxTicks = 40): Promise<void> {
    for (let i = 0; i < maxTicks; i++) {
      if (vi.mocked(chrome.alarms.create).mock.calls.length === 0) return;
      vi.mocked(chrome.alarms.create).mockClear();
      await handleBulkSyncTick();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("re-arms the alarm when the running tick stands down for a resume", async () => {
    await interruptedRun({ n: 6, handedOver: 3, pending: ["c2", "c3"] });
    let release!: () => void;
    fetchHold.promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stale = handleBulkSyncTick();
    await vi.waitFor(() => expect(fetched).toEqual(["c4"]));

    // the resume's own tick is skipped: the stale one is still running
    await restart();
    vi.mocked(chrome.alarms.create).mockClear();
    release();
    await stale;

    expect(vi.mocked(chrome.alarms.create)).toHaveBeenCalledWith("bulkSyncAlarm", {
      when: expect.any(Number),
    });
    await runWhileAlarmArmed();
    expect(await getBulkSyncState()).toBeNull();
    expect(fetched).toEqual(["c4", "c2", "c3", "c4", "c5", "c6"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ successCount: 6, failedCount: 0 });
  });

  it("does not arm an alarm for a run that is over", async () => {
    // every chat is settled: the first tick ends the run, and the second is asked for meanwhile
    await interruptedRun({ n: 2, handedOver: 2 });
    await clearStaleOperationLocks();
    const first = handleBulkSyncTick();
    const second = handleBulkSyncTick();
    await Promise.all([first, second]);
    await vi.waitFor(async () => expect(await getBulkSyncState()).toBeNull());

    expect(vi.mocked(chrome.alarms.create)).not.toHaveBeenCalled();
  });
});

describe("the run counts the media its chats could not store (HVN-159)", () => {
  const report = (chatId: string, runId: string, unstoredMedia?: number) =>
    ({
      type: "progress",
      chatId,
      runId,
      success: true,
      unstoredMedia,
      processed: 1,
      failed: 0,
      skipped: 0,
    }) as const;

  /** A run of `n` chats, all handed to the worker and none reported on. */
  async function allOut(n: number, resumeCount = 0): Promise<string> {
    const all = ids(n);
    const state = runState({
      chatIds: all,
      total: n,
      currentIndex: n,
      processedChatIds: all,
      resumeCount,
    });
    await setBulkSyncState(state);
    await setActiveOperation("bulkSync");
    await clearPendingHandoffs();
    for (const id of all) await addPendingHandoff(id);
    return `${STARTED}:${resumeCount}`;
  }

  it("says how many in the completion message, once the last chat is reported", async () => {
    const run = await allOut(3);

    await handleWorkerMessage(report("c1", run, 2));
    await handleWorkerMessage(report("c2", run, 0));
    expect(sent("bulkSyncComplete")).toHaveLength(0);
    await handleWorkerMessage(report("c3", run, 1));

    const [complete] = sent("bulkSyncComplete");
    expect(complete).toMatchObject({ unstoredMediaCount: 3, successCount: 3, failedCount: 0 });
    expect(complete.status).toContain("3 media files could not be stored; their links were kept.");
    expect((await getPendingHandoffs()).unstoredMedia).toBeUndefined();
  });

  it("says nothing of it when every file was stored, and speaks of one in the singular", async () => {
    const quiet = await allOut(1);
    await handleWorkerMessage(report("c1", quiet));
    expect(sent("bulkSyncComplete")[0].status).not.toContain("media");
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ unstoredMediaCount: 0 });

    vi.mocked(safeSendMessage).mockClear();
    const one = await allOut(1);
    await handleWorkerMessage(report("c1", one, 1));
    expect(sent("bulkSyncComplete")[0].status).toContain(
      "1 media file could not be stored; its link was kept.",
    );
  });

  it("does not count a report from another run", async () => {
    const run = await allOut(2, 1);

    await handleWorkerMessage(report("c1", `${STARTED}:0`, 5));
    await handleWorkerMessage(report("c1", run, 1));
    await handleWorkerMessage(report("c2", run, 1));

    expect(sent("bulkSyncComplete")[0]).toMatchObject({ unstoredMediaCount: 2 });
  });

  it("keeps the count of the chats settled before a restart, and adds the redone ones", async () => {
    // c1 was reported (2 not stored) before the restart; c2 was out and is fetched again
    await interruptedRun({ n: 2, handedOver: 2, pending: ["c2"] });
    await settlePendingHandoff("c1", 2);

    await restart();
    await driveToEnd();

    expect(fetched).toEqual(["c2"]);
    expect(sent("bulkSyncComplete")[0]).toMatchObject({ unstoredMediaCount: 2 });
  });

  it("starts a run's count at zero", async () => {
    await settlePendingHandoff("old", 9);
    await clearPendingHandoffs();

    expect((await getPendingHandoffs()).unstoredMedia).toBeUndefined();
  });
});
