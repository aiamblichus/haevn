import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBulkSync,
  handleBulkSyncTick,
  resumeBulkSync,
  startBulkSync,
  stopWaitingForWorker,
} from "../src/background/bulkSync/orchestrator";
import { bulkSyncStateManager } from "../src/background/bulkSync/stateManager";
import type { BulkSyncState } from "../src/background/bulkSync/types";
import {
  handleAbandonBulkSync,
  handleStartBulkSync,
} from "../src/background/handlers/syncHandlers";
import {
  cancelBulkSync,
  clearStaleOperationLocks,
  getActiveOperation,
  getBulkSyncState,
  setActiveOperation,
  setBulkSyncState,
} from "../src/background/state";
import { safeSendMessage } from "../src/background/utils/messageUtils";
import { createExtractionTab } from "../src/background/utils/tabUtils";
import { getStorageAdapter } from "../src/storage";

// HVN-126: a bulk sync is visible, and can be stopped, from the moment it holds the lock. It used
// to write its state only once the chat list was known, so a Stop during the wait found nothing to
// cancel. These tests hold the start inside its wait for the chat list, the way Gemini's long
// scroll does, and press Stop there.

const TAB = 42;
const LIST_ERROR = "The message port closed before a response was received.";

const { workerRequests, gate } = vi.hoisted(() => {
  // bulkSync.ts registers its worker listener when it loads, which syncHandlers does
  const runtime = (globalThis as unknown as { chrome: { runtime: object } }).chrome.runtime;
  Object.assign(runtime, { onMessage: { addListener: () => {} } });
  // A test holds a step open by setting its gate to a promise it resolves later
  const gate = {
    fetch: null as Promise<unknown> | null,
    reset: null as Promise<unknown> | null,
    indexing: null as Promise<unknown> | null,
  };
  return { workerRequests: [] as { type: string }[], gate };
});

vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: vi.fn(async (_worker: string, message: { type: string }) => {
    workerRequests.push(message);
    if (message.type === "reset") await gate.reset;
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
    fetch: async () => {
      await gate.fetch;
      return { success: true, data: { conversation: {} } };
    },
  }),
}));
vi.mock("../src/providers/provider", () => ({
  getProvider: (name: string) =>
    name === "nowhere"
      ? undefined
      : {
          name,
          bulkSyncConfig: { mode: "api", rateLimitDelayMs: 0 },
          getListUrl: () => "https://chatgpt.com/",
          buildChatUrl: (id: string) => `https://chatgpt.com/c/${id}`,
        },
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: {
    finishBulkSyncIndexing: vi.fn(async () => {
      await gate.indexing;
    }),
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

// A page that answers getChatIds only when the test says so, and fails the way Chrome does when
// its tab is closed under a pending message.
let chatListWaits: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>;
let closedTabs: number[];

function sentActions(): string[] {
  return vi.mocked(safeSendMessage).mock.calls.map(([m]) => m.action);
}

function sentMessage(action: string) {
  return vi
    .mocked(safeSendMessage)
    .mock.calls.map(([m]) => m)
    .find((m) => m.action === action);
}

function answerChatList(tabId: number, chatIds: string[]) {
  chatListWaits.get(tabId)?.resolve({ success: true, chatIds });
}

/** Lets the start run until it is waiting for the page's chat list in this tab; `start` is the run. */
async function startAndWaitForChatList(provider = "chatgpt", tabId = TAB) {
  vi.mocked(createExtractionTab).mockImplementationOnce(async (_url, options) => {
    options?.onCreated?.(tabId);
    return tabId;
  });
  const start = startBulkSync(0, provider, undefined, {});
  await vi.waitFor(() => expect(chatListWaits.has(tabId)).toBe(true));
  // in an object: a bare promise would be awaited along with the helper
  return { start };
}

beforeEach(async () => {
  workerRequests.length = 0;
  vi.mocked(createExtractionTab).mockReset();
  gate.fetch = gate.reset = gate.indexing = null;
  chatListWaits = new Map();
  closedTabs = [];
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn(async () => undefined), onMessage: { addListener: vi.fn() } },
    tabs: {
      get: vi.fn(async (id: number) => ({ id })),
      remove: vi.fn(async (id: number) => {
        closedTabs.push(id);
        // Chrome fails the pending message of a tab that goes away
        const wait = chatListWaits.get(id);
        if (wait) queueMicrotask(() => wait.reject(new Error(LIST_ERROR)));
      }),
      sendMessage: vi.fn((tabId: number, message: { action: string }) => {
        if (message.action === "getChatIds") {
          return new Promise((resolve, reject) => chatListWaits.set(tabId, { resolve, reject }));
        }
        return Promise.resolve({ platform: { name: "chatgpt" } });
      }),
    },
    alarms: { create: vi.fn(), clear: vi.fn() },
  });
  await setBulkSyncState(null);
  await setActiveOperation("idle");
});

afterEach(() => {
  vi.restoreAllMocks();
  stopWaitingForWorker();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("a bulk sync that is still looking for its chats", () => {
  it("has a state, and holds the lock, before the page has answered", async () => {
    const { start } = await startAndWaitForChatList();

    const state = await getBulkSyncState();
    expect(state).toMatchObject({
      status: "discovering",
      provider: "chatgpt",
      total: 0,
      currentIndex: 0,
      chatIds: [],
      extractionTabId: TAB,
    });
    expect(await getActiveOperation()).toBe("bulkSync");

    answerChatList(TAB, []);
    await start;
  });

  it("has its state before the first word of progress reaches a page", async () => {
    // a page that hears "Discovering chats..." re-reads the state: it must find the run
    let stateAtFirstProgress: BulkSyncState | null = null;
    vi.mocked(safeSendMessage).mockImplementationOnce(() => {
      void getBulkSyncState().then((s) => {
        stateAtFirstProgress = s;
      });
    });
    const { start } = await startAndWaitForChatList();

    expect(sentMessage("bulkSyncProgress")).toMatchObject({ status: "Discovering chats..." });
    await vi.waitFor(() => expect(stateAtFirstProgress).not.toBeNull());
    expect((stateAtFirstProgress as BulkSyncState | null)?.status).toBe("discovering");

    answerChatList(TAB, []);
    await start;
  });

  it("is a running sync, with its chats, once they are found", async () => {
    const { start } = await startAndWaitForChatList();
    const discovery = await getBulkSyncState();

    answerChatList(TAB, ["a", "b"]);
    await start;

    const state = await getBulkSyncState();
    expect(state).toMatchObject({
      status: "running",
      chatIds: ["a", "b"],
      total: 2,
      extractionTabId: TAB,
      startedAt: discovery?.startedAt,
    });
    expect(sentActions()).toContain("bulkSyncStarted");
    expect(sentActions()).not.toContain("bulkSyncFailed");
  });

  it("fails as before when the page has no chats", async () => {
    const { start } = await startAndWaitForChatList();

    answerChatList(TAB, []);
    await start;

    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(sentMessage("bulkSyncFailed")).toMatchObject({
      error: "No conversations found to sync.",
    });
    expect(closedTabs).toEqual([TAB]);
  });

  it("leaves no state behind for a provider it does not know", async () => {
    await startBulkSync(0, "nowhere", undefined, {});

    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(sentMessage("bulkSyncFailed")).toMatchObject({ error: "Unknown provider: nowhere" });
  });

  it("leaves a run that holds the lock alone when a second start finds the lock taken", async () => {
    const { start } = await startAndWaitForChatList();
    const before = await getBulkSyncState();

    await startBulkSync(0, "chatgpt", undefined, {});

    expect(await getBulkSyncState()).toEqual(before);
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(sentMessage("bulkSyncFailed")?.error).toContain("currently in progress");

    answerChatList(TAB, []);
    await start;
  });
});

describe("Stop while the sync is looking for its chats", () => {
  it("ends the run as cancelled: tab closed, lock released, no sync, no failure", async () => {
    const { start } = await startAndWaitForChatList();

    await cancelBulkSync();
    await start;

    expect(closedTabs).toContain(TAB);
    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(sentMessage("bulkSyncCanceled")).toMatchObject({
      provider: "chatgpt",
      status: "Canceled before any chat was synced.",
    });
    expect(sentActions()).not.toContain("bulkSyncFailed");
    expect(sentActions()).not.toContain("bulkSyncStarted");
    // nothing was synced, and nothing was set up that needs undoing: no bulk indexing began, no
    // alarm, no worker was asked for anything and the offscreen document was not woken
    const { SyncService } = await import("../src/services/syncService");
    expect(SyncService.startBulkSyncIndexing).not.toHaveBeenCalled();
    expect(SyncService.finishBulkSyncIndexing).not.toHaveBeenCalled();
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(workerRequests).toEqual([]);
    const { ensureOffscreenDocument } = await import("../src/background/utils/offscreenUtils");
    expect(ensureOffscreenDocument).not.toHaveBeenCalled();
  });

  it("is not mistaken for a failure of the page: the tab's closing reaches the start as an error", async () => {
    const { start } = await startAndWaitForChatList();

    await cancelBulkSync();
    // the pending getChatIds failed, as it does in Chrome; the start must stay quiet about it
    await start;

    const { log } = await import("../src/utils/logger");
    expect(log.error).not.toHaveBeenCalled();
    expect(sentActions().filter((a) => a === "bulkSyncCanceled")).toHaveLength(1);
  });

  it("closes a tab that is still loading and ends the run when the load finishes", async () => {
    let finishLoading: (id: number) => void = () => {};
    vi.mocked(createExtractionTab).mockImplementationOnce(async (_url, options) => {
      options?.onCreated?.(TAB);
      return new Promise<number>((resolve) => {
        finishLoading = resolve;
      });
    });
    const start = startBulkSync(0, "chatgpt", undefined, {});
    await vi.waitFor(async () => expect((await getBulkSyncState())?.extractionTabId).toBe(TAB));

    await cancelBulkSync();
    expect(closedTabs).toContain(TAB);
    expect(await getActiveOperation()).toBe("idle");

    finishLoading(TAB);
    await start;

    // the start never asked the closed tab for its chats, and did not report a failure
    expect(chatListWaits.size).toBe(0);
    expect(sentActions()).not.toContain("bulkSyncFailed");
    expect(await getBulkSyncState()).toBeNull();
  });

  it("does not release the lock of the run that follows it", async () => {
    const { start: first } = await startAndWaitForChatList("chatgpt", TAB);
    // the page is slow to notice its tab closed: hold the first start's failure back
    const firstWait = chatListWaits.get(TAB);
    chatListWaits.delete(TAB);
    await cancelBulkSync();

    // a second run takes the lock straight away
    const { start: second } = await startAndWaitForChatList("chatgpt", 77);
    firstWait?.reject(new Error(LIST_ERROR));
    await first;

    expect(await getActiveOperation()).toBe("bulkSync");
    expect((await getBulkSyncState())?.status).toBe("discovering");
    expect(sentActions().filter((a) => a === "bulkSyncFailed")).toEqual([]);

    answerChatList(77, ["a"]);
    await second;
    expect((await getBulkSyncState())?.status).toBe("running");
  });

  it("is still a failure when the tab is closed by someone else", async () => {
    const { start } = await startAndWaitForChatList();

    // not a Stop: the user closes the extraction tab
    chatListWaits.get(TAB)?.reject(new Error(LIST_ERROR));
    await start;

    expect(sentMessage("bulkSyncFailed")).toMatchObject({ error: LIST_ERROR });
    expect(sentActions()).not.toContain("bulkSyncCanceled");
    expect(await getActiveOperation()).toBe("idle");
    expect(await getBulkSyncState()).toBeNull();
  });
});

describe("a force reset while the sync is looking for its chats", () => {
  it("is not revived by the start, which closes its own tab and sends nothing", async () => {
    const { start } = await startAndWaitForChatList();

    // what handleForceResetBulkSync does: wipe the state and release the lock
    await setBulkSyncState(null);
    await setActiveOperation("idle");

    // a page that did answer, after the reset
    answerChatList(TAB, ["a", "b"]);
    await start;

    expect(await getBulkSyncState()).toBeNull();
    expect(sentActions()).not.toContain("bulkSyncStarted");
    expect(closedTabs).toEqual([TAB]);
    expect(chrome.alarms.create).not.toHaveBeenCalled();
  });

  it("leaves the run that follows it, its state and its lock, alone", async () => {
    const { start: first } = await startAndWaitForChatList("chatgpt", TAB);
    await setBulkSyncState(null);
    await setActiveOperation("idle");

    const { start: second } = await startAndWaitForChatList("chatgpt", 77);
    // the first page answers late, after the second run has taken the lock
    answerChatList(TAB, ["a", "b"]);
    await first;

    expect(await getActiveOperation()).toBe("bulkSync");
    expect((await getBulkSyncState())?.status).toBe("discovering");
    expect(closedTabs).toEqual([TAB]);
    expect(sentActions()).not.toContain("bulkSyncFailed");

    answerChatList(77, ["c"]);
    await second;
    expect((await getBulkSyncState())?.status).toBe("running");
  });
});

function discoveringState(overrides: Partial<BulkSyncState> = {}): BulkSyncState {
  return {
    status: "discovering",
    provider: "chatgpt",
    tabId: 0,
    extractionTabId: TAB,
    chatIds: [],
    total: 0,
    currentIndex: 0,
    isCancelled: false,
    failedSyncs: [],
    skippedCount: 0,
    platformName: undefined,
    overwriteExisting: false,
    isProcessing: false,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
    processedChatIds: [],
    ...overrides,
  };
}

describe("nothing mistakes a discovering run for one that can resume or tick", () => {
  beforeEach(async () => {
    await setBulkSyncState(discoveringState());
    await setActiveOperation("bulkSync");
  });

  it("is not an incomplete sync", async () => {
    expect(await bulkSyncStateManager.checkForIncompleteSync()).toBeNull();
    // and a check does not clear it: the run is alive
    expect((await getBulkSyncState())?.status).toBe("discovering");
  });

  it("is not offered for resume when Sync all is pressed again", async () => {
    const sendResponse = vi.fn();

    await handleStartBulkSync(
      { action: "startBulkSync", provider: "chatgpt", options: {} },
      sendResponse,
    );

    expect(sendResponse).toHaveBeenCalledWith({ success: true });
    await vi.waitFor(() => expect(sentMessage("bulkSyncFailed")).toBeDefined());
    // the second start found the lock taken and left the run as it was
    expect((await getBulkSyncState())?.status).toBe("discovering");
    expect(await getActiveOperation()).toBe("bulkSync");
  });

  it("cannot be resumed", async () => {
    await resumeBulkSync("chatgpt");

    expect(sentMessage("bulkSyncFailed")).toMatchObject({
      error: "No incomplete sync found for this provider",
    });
    expect((await getBulkSyncState())?.status).toBe("discovering");
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(closedTabs).toEqual([]);
  });

  it("cannot be abandoned: Stop ends it, and abandoning would leave its lock and tab", async () => {
    const sendResponse = vi.fn();

    await handleAbandonBulkSync({ action: "abandonBulkSync", provider: "chatgpt" }, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, errorCode: "NO_INCOMPLETE_SYNC" }),
    );
    expect((await getBulkSyncState())?.status).toBe("discovering");
  });

  it("is not ended by a stray alarm tick", async () => {
    await handleBulkSyncTick();

    expect((await getBulkSyncState())?.status).toBe("discovering");
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(closedTabs).toEqual([]);
    expect(sentActions()).not.toContain("bulkSyncComplete");
  });
});

describe("a service-worker restart while the sync is looking for its chats", () => {
  it("drops the run, frees the lock, closes its tab, and tells an open page", async () => {
    await setBulkSyncState(discoveringState());
    await setActiveOperation("bulkSync");

    await clearStaleOperationLocks();

    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(closedTabs).toEqual([TAB]);
    expect(sentMessage("bulkSyncFailed")).toMatchObject({
      provider: "chatgpt",
      error: expect.stringContaining("looking for chats"),
    });
    // nothing is left for the start-up's resume to find, or to block the next run
    expect(await bulkSyncStateManager.checkForIncompleteSync()).toBeNull();
  });

  it("drops a run whose tab was never recorded", async () => {
    await setBulkSyncState(discoveringState({ extractionTabId: null }));
    await setActiveOperation("bulkSync");

    await clearStaleOperationLocks();

    expect(await getBulkSyncState()).toBeNull();
    expect(closedTabs).toEqual([]);
  });

  it("still keeps a running sync for resume", async () => {
    await setBulkSyncState(
      discoveringState({ status: "running", chatIds: ["a", "b"], total: 2, currentIndex: 1 }),
    );
    await setActiveOperation("bulkSync");

    await clearStaleOperationLocks();

    expect((await getBulkSyncState())?.status).toBe("running");
    expect(closedTabs).toEqual([]);
    expect((await bulkSyncStateManager.checkForIncompleteSync())?.chatIds).toEqual(["a", "b"]);
  });
});

describe("the cancelled message", () => {
  it("still counts the chats of a run that had them", async () => {
    await setBulkSyncState(
      discoveringState({
        status: "cancelled",
        chatIds: ["a", "b", "c"],
        total: 3,
        currentIndex: 1,
      }),
    );

    await cleanupBulkSync(await getBulkSyncState());

    expect(sentMessage("bulkSyncCanceled")).toMatchObject({
      status: "Canceled after 1 of 3 chats.",
    });
  });
});

// An ender (a Stop's cleanup, an old tick, a start's finally) ends the run it was given. These
// tests hold one step of an old run open, start the next run meanwhile, and let the old step finish.

/** A promise a test settles later, to hold a step of the code under test open. */
function hold(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** Presses Sync all while the lock is taken: the second start must be turned away. */
async function pressSyncAllWhileLockIsHeld(tabId = 77) {
  vi.mocked(createExtractionTab).mockImplementationOnce(async (_url, options) => {
    options?.onCreated?.(tabId);
    return tabId;
  });
  const second = startBulkSync(0, "chatgpt", undefined, {});
  await vi.waitFor(() => expect(sentMessage("bulkSyncFailed")).toBeDefined(), { timeout: 800 });
  expect(sentMessage("bulkSyncFailed")?.error).toContain("currently in progress");
  await second;
}

describe("an ender never cleans up a run that is not the one it was ending", () => {
  it("an old tick winding down after a Stop leaves the next run's discovery alone", async () => {
    await setBulkSyncState(
      discoveringState({
        status: "running",
        chatIds: ["a", "b", "c"],
        total: 3,
        startedAt: 1,
        extractionTabId: TAB,
      }),
    );
    await setActiveOperation("bulkSync");
    const fetch = hold();
    gate.fetch = fetch.gate;
    const tick = handleBulkSyncTick();
    await vi.waitFor(() => expect(chrome.tabs.get).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20)); // the tick is inside its fetch

    await cancelBulkSync(); // Stop on the running sync: cleaned up, lock free
    const { start: second } = await startAndWaitForChatList("chatgpt", 77); // Sync all again
    closedTabs.length = 0;
    vi.mocked(safeSendMessage).mockClear();
    workerRequests.length = 0;

    fetch.release(); // the old tick's fetch returns
    await tick;

    const state = await getBulkSyncState();
    expect(state).toMatchObject({
      status: "discovering",
      extractionTabId: 77,
      currentIndex: 0,
      processedChatIds: [],
    });
    expect(state?.startedAt).not.toBe(1);
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(closedTabs).toEqual([]);
    expect(sentActions()).not.toContain("bulkSyncComplete");
    // the chat the old tick fetched belongs to nobody: it is not handed to the worker
    expect(workerRequests.filter((m) => m.type === "sync")).toEqual([]);

    answerChatList(77, ["x"]);
    await second;
    expect((await getBulkSyncState())?.status).toBe("running");
  });

  it("a cleanup that is for an earlier run does not wipe or free the later run", async () => {
    const earlier = discoveringState({ status: "cancelled", startedAt: 1, extractionTabId: 5 });
    await setBulkSyncState(discoveringState({ startedAt: 2, extractionTabId: 77 }));
    await setActiveOperation("bulkSync");

    await cleanupBulkSync(earlier);

    expect((await getBulkSyncState())?.startedAt).toBe(2);
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(closedTabs).toEqual([5]); // its own tab is still closed
    expect(sentActions()).not.toContain("bulkSyncCanceled");
    // nor does it reset the later run's worker or clear its alarm (Gauge F9)
    expect(workerRequests).toEqual([]);
    expect(chrome.alarms.clear).not.toHaveBeenCalled();
  });

  it("a Stop's cleanup keeps the lock until the state is wiped, so no run starts inside it", async () => {
    await setBulkSyncState(
      discoveringState({ status: "running", chatIds: ["a"], total: 1, extractionTabId: TAB }),
    );
    await setActiveOperation("bulkSync");
    const reset = hold();
    gate.reset = reset.gate;

    const cancel = cancelBulkSync();
    await vi.waitFor(() => expect(workerRequests.some((m) => m.type === "reset")).toBe(true));
    await pressSyncAllWhileLockIsHeld();
    expect(await getActiveOperation()).toBe("bulkSync");

    reset.release();
    await cancel;
    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(sentMessage("bulkSyncCanceled")).toBeDefined();
  });

  it("Stop on a discovering run holds the lock until the state is wiped", async () => {
    const { start } = await startAndWaitForChatList();
    // hold the wipe of the state open
    const adapter = getStorageAdapter();
    const remove = adapter.remove.bind(adapter);
    const wipe = hold();
    const wiping = vi.fn();
    vi.spyOn(adapter, "remove").mockImplementationOnce(async (key) => {
      wiping();
      await wipe.gate;
      return remove(key);
    });

    const cancel = cancelBulkSync();
    await vi.waitFor(() => expect(wiping).toHaveBeenCalled());
    await pressSyncAllWhileLockIsHeld();
    expect(await getActiveOperation()).toBe("bulkSync");

    wipe.release();
    await cancel;
    await start;
    expect(await getBulkSyncState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(sentActions().filter((a) => a === "bulkSyncCanceled")).toHaveLength(1);
  });

  it("an early completion keeps the lock until it has finished, so its finally cannot free a later run's", async () => {
    const { SyncService } = await import("../src/services/syncService");
    vi.mocked(SyncService.batchCheckExistingChats).mockResolvedValueOnce(new Set(["a"]));
    const indexing = hold();
    gate.indexing = indexing.gate;
    const { start } = await startAndWaitForChatList();

    answerChatList(TAB, ["a"]); // every chat is already synced
    await vi.waitFor(() => expect(SyncService.finishBulkSyncIndexing).toHaveBeenCalled());
    expect(sentMessage("bulkSyncComplete")).toBeDefined();
    await pressSyncAllWhileLockIsHeld();

    indexing.release();
    await start;
    expect(await getActiveOperation()).toBe("idle");
    expect(await getBulkSyncState()).toBeNull();
  });

  it("an early completion has wiped the state before it says complete", async () => {
    const { SyncService } = await import("../src/services/syncService");
    vi.mocked(SyncService.batchCheckExistingChats).mockResolvedValueOnce(new Set(["a"]));
    let stateAtComplete: Promise<unknown> | undefined;
    vi.mocked(safeSendMessage).mockImplementation((m: { action: string }) => {
      if (m.action === "bulkSyncComplete") stateAtComplete = getBulkSyncState();
    });
    const { start } = await startAndWaitForChatList();

    answerChatList(TAB, ["a"]); // every chat is already synced
    await start;

    expect(stateAtComplete).toBeDefined();
    // a page that re-reads the state on "complete" must not find a discovering run
    expect(await stateAtComplete).toBeNull();
    expect(closedTabs).toContain(TAB);
  });
});

describe("a failure before the run has a state is a failure, not a Stop", () => {
  it("frees the lock and says so when the first state write fails", async () => {
    const adapter = getStorageAdapter();
    const write = adapter.set.bind(adapter);
    // the first write is the lock, the second the discovering state
    vi.spyOn(adapter, "set")
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error("storage is full"));

    await startBulkSync(0, "chatgpt", undefined, {});

    expect(await getActiveOperation()).toBe("idle");
    expect(sentMessage("bulkSyncFailed")).toMatchObject({ error: "storage is full" });
    expect(createExtractionTab).not.toHaveBeenCalled();
  });

  it("does not leave a rejected promise behind when the tab's id cannot be recorded", async () => {
    const adapter = getStorageAdapter();
    const write = adapter.set.bind(adapter);
    // the lock, the discovering state, then the tab's id
    vi.spyOn(adapter, "set")
      .mockImplementationOnce(write)
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(new Error("storage is full"));
    vi.mocked(createExtractionTab).mockImplementationOnce(async (_url, options) => {
      options?.onCreated?.(TAB);
      throw new Error("the page did not load");
    });

    await startBulkSync(0, "chatgpt", undefined, {});
    await new Promise((resolve) => setTimeout(resolve, 20)); // an unhandled rejection surfaces here

    expect(sentMessage("bulkSyncFailed")).toMatchObject({ error: "the page did not load" });
    expect(await getActiveOperation()).toBe("idle");
    expect(closedTabs).toEqual([TAB]);
  });
});
