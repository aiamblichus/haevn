import { getProvider } from "../../providers/provider";
import { SyncService } from "../../services/syncService";
import { log } from "../../utils/logger";
import { sendWorkerRequest } from "../../utils/workerApi";
import {
  acquireOperationLock,
  getActiveOperation,
  getBulkSyncState,
  releaseOperationLock,
  setBulkSyncState,
} from "../state";
import { safeSendMessage } from "../utils/messageUtils";
import { ensureOffscreenDocument } from "../utils/offscreenUtils";
import { createExtractionTab } from "../utils/tabUtils";
import { type FetchDataResult, getStrategy } from "./fetchStrategies";
import {
  addPendingHandoff,
  clearPendingHandoffs,
  getPendingHandoffs,
  settlePendingHandoff,
  workerIdleMs,
} from "./pendingHandoffs";
import { syncRunId } from "./runId";
import { planResume } from "./stateManager";
import type { BulkSyncOptions, BulkSyncState } from "./types";

export const BULK_SYNC_ALARM_NAME = "bulkSyncAlarm";
const FETCH_BATCH_SIZE = 5; // Fetch 5 chats at once and send to worker
const MAX_TICK_TIME_MS = 25000; // Max 25 seconds per tick to leave buffer for next alarm

// The worker's transform downloads each chat's media through the extraction tab, so the tab stays
// open until the worker has reported on every chat handed to it (HVN-123). A worker that has
// handed nothing back and asked for nothing for this long is taken to be dead: the sync gives up
// waiting and closes. One download is over in 40 s at most, so a live worker is never this quiet.
export const WORKER_IDLE_GIVE_UP_MS = 3 * 60 * 1000;
const WORKER_RECHECK_MS = 5000;
// Backstop for a service worker that is suspended while it waits: its timer is gone, an alarm is not.
const WORKER_RECHECK_ALARM_MS = 30000;

function isTabNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("No tab with id:");
}

async function removeextractionTabBestEffort(tabId: number, context: string): Promise<void> {
  try {
    await chrome.tabs.remove(tabId);
  } catch (err) {
    if (isTabNotFoundError(err)) {
      log.debug(`[Bulk Sync] extraction tab ${tabId} already gone during ${context}`);
      return;
    }
    log.warn(`[Bulk Sync] Failed to remove extraction tab ${tabId} during ${context}:`, err);
  }
}

/**
 * Thrown inside `startBulkSync` when the run is no longer the start's: it was cancelled or reset
 * while it was discovering. Whoever ended it has cleaned up (lock, tab, state, message), so the
 * start leaves quietly instead of reporting a failure or releasing a lock that may be the next
 * run's (HVN-126).
 */
class DiscoveryEnded extends Error {}

// A start's `startedAt` is its identity while it discovers, so no two starts may share one, even in
// the same millisecond.
let _lastStartedAt = 0;
function nextStartedAt(): number {
  _lastStartedAt = Math.max(Date.now(), _lastStartedAt + 1);
  return _lastStartedAt;
}

/** True while the state in storage is still this start's discovery: not cancelled, reset or replaced. */
async function isDiscoveryMine(startedAt: number): Promise<boolean> {
  const state = await getBulkSyncState();
  return state?.status === "discovering" && state.startedAt === startedAt;
}

/** What `recoverextractionTab` answers when the run it was recovering for has been replaced. */
const SUPERSEDED = "superseded";

/**
 * Opens a new extraction tab for a run whose tab is gone. Null when it cannot. It takes seconds, and
 * a resume may land meanwhile: it then closes the tab it made and answers SUPERSEDED, and writes
 * nothing, so the resume's list, index and tab are not written over (HVN-127).
 */
async function recoverextractionTab(
  state: BulkSyncState,
): Promise<BulkSyncState | null | typeof SUPERSEDED> {
  const providerModule = state.provider ? getProvider(state.provider) : null;
  const listUrl = providerModule?.getListUrl(state.baseUrl);
  if (!listUrl) {
    return null;
  }

  const useForegroundextractionTab =
    state.provider === "gemini" || !!providerModule?.bulkSyncConfig?.requiresActiveTab;
  const newextractionTabId = await createExtractionTab(listUrl, {
    active: useForegroundextractionTab,
  });

  // The old tab goes before the re-read, so nothing is awaited between the read and the write: a
  // resume landing during the removal is seen below (Gauge N5, HVN-124).
  if (state.extractionTabId !== null && state.extractionTabId !== newextractionTabId) {
    await removeextractionTabBestEffort(state.extractionTabId, "tab recovery");
  }

  const latest = await getBulkSyncState();
  if (!latest || syncRunId(latest) !== syncRunId(state)) {
    await removeextractionTabBestEffort(
      newextractionTabId,
      "tab recovery of a run that was replaced",
    );
    return SUPERSEDED;
  }

  const recoveredState: BulkSyncState = {
    ...latest,
    extractionTabId: newextractionTabId,
  };

  await setBulkSyncState(recoveredState);
  return recoveredState;
}

/**
 * Ensures the offscreen document is ready (it manages the worker)
 */
async function ensureSyncWorkerReady(): Promise<void> {
  await ensureOffscreenDocument();
}

/**
 * Central dispatcher for fetching conversation data.
 * Decides which strategy to use based on provider's BulkSyncConfig.
 * This is the single decision point for all data fetching strategies.
 */
async function fetchConversationData(
  state: BulkSyncState,
  chatId: string,
  url: string,
): Promise<FetchDataResult> {
  if (state.extractionTabId === null) {
    return {
      success: false,
      error: "extraction tab not available",
    };
  }

  // Get provider's bulk sync config
  const providerModule = state.provider ? getProvider(state.provider) : null;
  const syncConfig = providerModule?.bulkSyncConfig;

  // Use Strategy Pattern to fetch data
  const strategy = getStrategy(syncConfig);

  return strategy.fetch({
    tabId: state.extractionTabId,
    chatId,
    url,
    baseUrl: state.baseUrl,
    platformName: state.platformName || state.provider,
    options: { overwriteExisting: state.overwriteExisting },
  });
}

/**
 * Starts a new bulk sync operation.
 * Initializes state, extracts chat IDs using a new extraction tab, and creates an alarm for processing.
 */
export async function startBulkSync(
  _tabId: number, // Still accepts tabId for backward compatibility, but uses a new extraction tab
  provider: string,
  baseUrl: string | undefined,
  options: BulkSyncOptions,
): Promise<void> {
  // NOTE: Incomplete sync check moved to handler (handleStartBulkSync)
  // to return proper response type instead of sending event

  // Try to acquire operation lock
  const lockAcquired = await acquireOperationLock("bulkSync");
  if (!lockAcquired) {
    const activeOp = await getActiveOperation();
    safeSendMessage({
      action: "bulkSyncFailed",
      provider,
      error: `Cannot start bulk sync: ${activeOp} is currently in progress.`,
    });
    return;
  }

  // The run is visible and can be cancelled from the moment it holds the lock: a state in the
  // "discovering" phase, with no chats yet (HVN-126). `startedAt` tells it from a later run.
  const startedAt = nextStartedAt();
  // Set once the state has been handed on as a running sync: from then on the tick owns it
  let handedOver = false;
  // Set once the discovering state is in storage: before that, a failure is a failure, not a Stop
  let stateWritten = false;
  // Set when someone else ended the run while it was discovering: they wiped the state and
  // released the lock
  let endedElsewhere = false;
  const ensureMine = async (): Promise<void> => {
    if (!(await isDiscoveryMine(startedAt))) throw new DiscoveryEnded();
  };

  // Wrap entire initialization in try-finally to ensure lock is always released on error
  try {
    await setBulkSyncState({
      status: "discovering",
      provider,
      tabId: 0,
      extractionTabId: null,
      baseUrl,
      chatIds: [],
      total: 0,
      currentIndex: 0,
      isCancelled: false,
      failedSyncs: [],
      skippedCount: 0,
      platformName: undefined,
      overwriteExisting: options?.overwriteExisting === true,
      isProcessing: false,
      startedAt,
      lastProgressAt: startedAt,
      processedChatIds: [],
    });
    stateWritten = true;

    const providerModule = getProvider(provider);
    if (!providerModule) {
      await setBulkSyncState(null);
      safeSendMessage({
        action: "bulkSyncFailed",
        provider,
        error: `Unknown provider: ${provider}`,
      });
      return;
    }
    // Send immediate status update
    safeSendMessage({
      action: "bulkSyncProgress",
      provider,
      baseUrl,
      progress: 0,
      status: "Discovering chats...",
    });

    // Get list URL for the provider
    const listUrl = providerModule.getListUrl(baseUrl);
    if (!listUrl) {
      throw new Error("Provider does not support bulk sync");
    }

    // Get all chat IDs from the list page using a new extraction tab
    safeSendMessage({
      action: "bulkSyncProgress",
      provider,
      baseUrl,
      progress: 5,
      status: "Extracting chat IDs from the page...",
    });

    // Create extraction tab pointing to list URL. The state learns the tab the moment it exists, so
    // a Stop (or a restart) while the page loads can close it.
    const useForegroundextractionTab =
      provider === "gemini" || !!providerModule.bulkSyncConfig?.requiresActiveTab;
    const opened: { id: number | null } = { id: null };
    let tabRecorded: Promise<void> = Promise.resolve();
    let extractionTabId: number;
    try {
      extractionTabId = await createExtractionTab(listUrl, {
        active: useForegroundextractionTab,
        onCreated: (id) => {
          opened.id = id;
          // Check then write, not atomic: a Stop landing between the two is overwritten, which a
          // second Stop undoes. Accepted (HVN-126). A failed write only costs the Stop its tab id;
          // the start closes its own tab when it finds the run ended.
          tabRecorded = (async () => {
            const state = await getBulkSyncState();
            if (state?.status === "discovering" && state.startedAt === startedAt) {
              await setBulkSyncState({ ...state, extractionTabId: id });
            }
          })().catch((err) => log.warn("[Bulk Sync] Could not record the extraction tab:", err));
        },
      });
    } catch (tabError) {
      // The tab opened but did not load: close what there is
      if (opened.id !== null) {
        await removeextractionTabBestEffort(opened.id, "extraction tab setup failure");
      }
      throw tabError;
    }

    try {
      await tabRecorded;
      await ensureMine();

      // Get chat IDs via content script in tab. Closing the tab (a Stop) ends this wait.
      const chatIdsResponse = await chrome.tabs.sendMessage(extractionTabId, {
        action: "getChatIds",
      });
      await ensureMine();

      if (!chatIdsResponse?.success || !chatIdsResponse?.chatIds) {
        throw new Error(chatIdsResponse?.error || "Failed to get chat IDs from the page.");
      }
      const chatIds = chatIdsResponse.chatIds;
      log.info("Received chat IDs for bulk sync:", chatIds);
      const totalChats = chatIds.length;
      if (totalChats === 0) {
        throw new Error("No conversations found to sync.");
      }

      // Ask content script which platform we're on
      let platformName: string | undefined;
      try {
        const det = await chrome.tabs.sendMessage(extractionTabId, {
          action: "detectPlatform",
        });
        platformName = det?.platform?.name;
      } catch (err) {
        log.warn("[Bulk Sync] Failed to detect platform:", err);
      }

      await ensureMine();
      const overwriteExisting = options?.overwriteExisting === true;
      log.info(`[Bulk Sync] Starting bulk sync with overwriteExisting=${overwriteExisting}`);

      // Filter out chats that already exist if overwrite is disabled
      // This happens BEFORE we start navigating to individual chats
      let chatsToSync = chatIds;
      let skippedCount = 0;
      if (!overwriteExisting && platformName) {
        safeSendMessage({
          action: "bulkSyncProgress",
          provider,
          baseUrl,
          progress: 10,
          status: `Checking ${chatIds.length} chats for existing syncs...`,
        });

        log.info(
          `[Bulk Sync] Overwrite disabled - checking which of ${chatIds.length} chats already exist...`,
        );
        const existingChats = await SyncService.batchCheckExistingChats(chatIds, platformName);
        await ensureMine();
        skippedCount = existingChats.size;
        chatsToSync = chatIds.filter((id: string) => !existingChats.has(id));
        log.info(
          `[Bulk Sync] Filtered: ${chatsToSync.length} new chats to sync, ${skippedCount} existing chats skipped`,
        );
        if (skippedCount > 0) {
          log.info(
            `[Bulk Sync] Skipped chat IDs (already synced):`,
            Array.from(existingChats).slice(0, 10),
            skippedCount > 10 ? `... and ${skippedCount - 10} more` : "",
          );
        }

        // Update status with filtering results
        safeSendMessage({
          action: "bulkSyncProgress",
          provider,
          baseUrl,
          progress: 15,
          status: `Found ${chatsToSync.length} chats to sync${
            skippedCount > 0 ? ` (${skippedCount} skipped)` : ""
          }...`,
          skippedCount,
        });
      } else if (overwriteExisting) {
        log.info(
          `[Bulk Sync] Overwrite enabled - syncing all ${chatIds.length} chats (including existing)`,
        );
      }

      if (chatsToSync.length === 0) {
        const status =
          skippedCount > 0
            ? `All ${chatIds.length} chats are already synced.`
            : "No conversations found to sync.";

        log.info(`[Bulk Sync] ${status}`);

        // The tab and the state go before the message: a page that re-reads the state when it hears
        // "complete" must find no run (Gauge F8, HVN-126). The lock goes last, in the finally below,
        // so no new run starts while the old state is still there to be wiped.
        await removeextractionTabBestEffort(extractionTabId, "early completion cleanup");
        await setBulkSyncState(null);

        // Send completion message directly as we haven't started processing
        safeSendMessage({
          action: "bulkSyncComplete",
          provider,
          baseUrl,
          status,
          failedCount: 0,
          skippedCount,
          successCount: 0,
          totalCount: chatIds.length,
        });

        // Finish indexing since we're done
        try {
          await SyncService.finishBulkSyncIndexing();
        } catch (err) {
          log.warn("[Bulk Sync] Failed to finish indexing on early exit:", err);
        }
        return;
      }

      // Initialize state
      // Store extraction tab ID for reuse during sync
      const initialState: BulkSyncState = {
        status: "running",
        provider,
        tabId: 0, // Legacy, kept for backward compatibility
        extractionTabId: extractionTabId, // Tab used for extraction
        baseUrl,
        chatIds: chatsToSync,
        total: chatsToSync.length,
        currentIndex: 0,
        isCancelled: false,
        failedSyncs: [],
        skippedCount,
        platformName,
        overwriteExisting,
        isProcessing: false,
        // Resume functionality (Spec 03.02)
        startedAt, // the discovery's: this is the same run
        lastProgressAt: Date.now(),
        processedChatIds: [],
      };

      await clearPendingHandoffs();
      // A Stop that landed while the chats were being checked has ended the run: do not revive it
      await ensureMine();
      // A Stop ends a discovering run by wiping its state and then freeing the lock: a lock that
      // is gone means this run is over, even if its state was read just before. The read and the
      // write below are still two steps; a Stop landing between them is accepted (HVN-126).
      if ((await getActiveOperation()) !== "bulkSync") throw new DiscoveryEnded();
      await setBulkSyncState(initialState);
      handedOver = true;

      // Enable bulk sync indexing mode to defer index rebuilds
      await SyncService.startBulkSyncIndexing();

      // Send initial progress update
      safeSendMessage({
        action: "bulkSyncProgress",
        provider,
        baseUrl,
        progress: 20,
        status: `Starting sync of ${chatsToSync.length} chats...`,
        failedCount: 0,
        skippedCount,
      });

      // Create alarm that fires immediately
      // NOT periodic - handleBulkSyncTick will schedule the next one if needed
      chrome.alarms.create(BULK_SYNC_ALARM_NAME, {
        when: Date.now(),
      });

      safeSendMessage({
        action: "bulkSyncStarted",
        provider,
        baseUrl,
        total: chatsToSync.length,
        skippedCount,
      });

      // Process first batch immediately
      await handleBulkSyncTick();
    } catch (extractError) {
      // Clean up extraction tab on error
      await removeextractionTabBestEffort(extractionTabId, "initialization error cleanup");
      throw extractError;
    }
  } catch (error) {
    // Stopped while it was discovering (a Stop, a reset): whoever ended it did the clean-up and
    // sent the message. Closing the tab is what made the pending getChatIds fail, so an error here
    // is the Stop, not a failure of the sync. Before the first state write there is no run to be
    // stopped: that error is a failure, and the lock is this start's to release.
    if (
      stateWritten &&
      !handedOver &&
      (error instanceof DiscoveryEnded || !(await isDiscoveryMine(startedAt)))
    ) {
      log.info("[Bulk Sync] Discovery ended before the chats were found; nothing to clean up");
      endedElsewhere = true;
      return;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Bulk sync initialization failed:", errorMessage, error);
    // Finish indexing even on initialization failure
    try {
      await SyncService.finishBulkSyncIndexing();
    } catch (err) {
      log.warn("[Bulk Sync] Failed to finish indexing on init error:", err);
    }
    await setBulkSyncState(null);
    safeSendMessage({
      action: "bulkSyncFailed",
      provider,
      baseUrl,
      error: error instanceof Error ? error.message : "An unknown error occurred.",
    });
  } finally {
    // Always release lock if we hit an error during initialization
    // Note: On success, the lock is held and released in cleanupBulkSync()
    // A state with another startedAt is a later run's, which has taken the lock by now: not ours
    // to release.
    if (!endedElsewhere) {
      const state = await getBulkSyncState();
      if (!state || (state.startedAt === startedAt && state.status !== "running")) {
        await releaseOperationLock("bulkSync");
      }
    }
  }
}

// In-memory re-entrancy guard. The storage-based isProcessing flag has a TOCTOU
// race: the alarm macrotask can fire between the storage read (isProcessing=false)
// and the storage write (isProcessing=true), starting a second concurrent tick.
// This module-level flag is checked and set synchronously, eliminating the race.
let _tickRunning = false;
// Set when a tick was asked for while another was running. The running one may be about to leave
// without re-arming the alarm (it found a resume, or a Stop, and stood down), and nothing else would
// tick the run until the service worker next wakes.
let _tickSkipped = false;

/**
 * Processes one batch of chats (called by alarm listener).
 * Fetches data for up to FETCH_BATCH_SIZE chats and sends to worker for processing.
 */
export async function handleBulkSyncTick(): Promise<void> {
  // Synchronous guard — no await before the check+set, so no race condition
  if (_tickRunning) {
    log.debug("[Bulk Sync] Tick already running in this context, skipping.");
    _tickSkipped = true;
    return;
  }
  _tickRunning = true;

  try {
    let state = await getBulkSyncState();
    // A run still looking for its chats has nothing to tick, and is not ended by a stray alarm
    if (state?.status === "discovering") return;
    // Check for termination conditions: no state, or not in 'running' state
    if (!state || state.status !== "running") {
      await cleanupBulkSync(state);
      return;
    }

    // This tick drives this run. Whatever it reads later that belongs to another run (a Stop, then
    // a new Sync all, while a fetch was in flight) is not the tick's to touch, clean up or write to
    // (HVN-126). A resume is another run for the tick, though it keeps `startedAt`: it rewrites the
    // list and the index, and a tick that began before it must not write over them (HVN-127). Ending
    // a run (`cleanupBulkSync`, the start) stays keyed on `startedAt`, which a resume keeps.
    const runId = syncRunId(state);
    const isAnotherRun = (s: BulkSyncState | null): boolean => s !== null && syncRunId(s) !== runId;

    if (state.currentIndex >= state.total) {
      await finishWhenWorkerIdle();
      return;
    }

    // Keep storage flag in sync for cross-session stale-state detection
    await setBulkSyncState({ ...state, isProcessing: true });

    // Re-fetch state
    const processingState = await getBulkSyncState();
    if (!processingState || processingState.status !== "running") {
      return;
    }
    if (isAnotherRun(processingState)) return;
    state = processingState;

    // Ensure offscreen document is ready (it manages the worker)
    await ensureSyncWorkerReady();

    const startTime = Date.now();
    const endIdx = Math.min(state.currentIndex + FETCH_BATCH_SIZE, state.chatIds.length);

    // Pre-fetch provider module for the whole batch
    const providerModule = getProvider(state.provider);
    if (!providerModule) {
      log.error(`[Bulk Sync] Unknown provider: ${state.provider}`);
      state.status = "error";
      await cleanupBulkSync(state);
      return;
    }

    // OPTIMIZATION: Pipeline fetch and worker processing
    // Track politeness delay promise to overlap with worker processing
    let delayPromise: Promise<void> | null = null;

    // Fetch data for batch and send to worker
    for (let i = state.currentIndex; i < endIdx; i++) {
      // Re-check cancellation and state
      let currentState = await getBulkSyncState();
      if (isAnotherRun(currentState)) return;
      if (!currentState || currentState.status !== "running") {
        await cleanupBulkSync(currentState);
        return;
      }
      state = currentState;

      // PIPELINING: Wait for previous iteration's delay before fetching
      // This ensures we respect rate limits while allowing worker to process in parallel
      if (delayPromise) {
        await delayPromise;
        delayPromise = null;
        // The delay is as long as the provider's rate limit: a resume may have landed in it, and the
        // state read before it is then the earlier run's
        const afterDelay = await getBulkSyncState();
        if (isAnotherRun(afterDelay)) return;
        if (!afterDelay || afterDelay.status !== "running") {
          await cleanupBulkSync(afterDelay);
          return;
        }
      }

      // Check if extraction tab is still valid
      if (state.extractionTabId === null) {
        log.warn("[Bulk Sync] extraction tab ID missing. Attempting recovery.");
        const recoveredState = await recoverextractionTab(state);
        if (recoveredState === SUPERSEDED) return;
        if (!recoveredState) {
          await setBulkSyncState({
            ...state,
            status: "error",
            failedSyncs: [
              ...state.failedSyncs,
              {
                chatId: state.chatIds[i],
                error: "extraction tab unavailable and could not be recreated",
              },
            ],
          });
          await cleanupBulkSync(await getBulkSyncState());
          return;
        }
        state = recoveredState;
      } else {
        try {
          await chrome.tabs.get(state.extractionTabId);
        } catch (err) {
          log.warn(
            `[Bulk Sync] extraction tab ${state.extractionTabId} is no longer valid, recovering...`,
            err,
          );
          const recoveredState = await recoverextractionTab(state);
          if (recoveredState === SUPERSEDED) return;
          if (!recoveredState) {
            await setBulkSyncState({
              ...state,
              status: "error",
              failedSyncs: [
                ...state.failedSyncs,
                {
                  chatId: state.chatIds[i],
                  error: "extraction tab was closed or became invalid",
                },
              ],
            });
            await cleanupBulkSync(await getBulkSyncState());
            return;
          }
          state = recoveredState;
        }
      }

      const chatId = state.chatIds[i];
      log.info(`[Bulk Sync] Fetching data for chat ${i + 1}/${state.total}: ${chatId}`);

      try {
        // Build chat URL
        const url = providerModule.buildChatUrl(chatId, state.baseUrl);

        // Update progress
        const progress = ((i + 1) / state.total) * 100;
        currentState = await getBulkSyncState();
        if (!currentState) break;
        if (isAnotherRun(currentState)) return;
        state = currentState;

        // Build status message with counts in format: "1/20, 50 skipped, 3 failed"
        const parts: string[] = [];
        parts.push(`${i + 1}/${state.total}`);
        if (state.skippedCount > 0) {
          parts.push(`${state.skippedCount} skipped`);
        }
        if (currentState.failedSyncs.length > 0) {
          parts.push(`${currentState.failedSyncs.length} failed`);
        }
        const status = `Syncing ${parts.join(", ")}...`;

        safeSendMessage({
          action: "bulkSyncProgress",
          provider: state.provider,
          baseUrl: state.baseUrl,
          progress,
          status,
          failedCount: currentState.failedSyncs.length,
          skippedCount: currentState.skippedCount,
        });

        // Fetch data using the centralized dispatcher
        // The dispatcher decides which strategy to use (API vs navigation)
        const dataResponse = await fetchConversationData(state, chatId, url);
        // The fetch can take seconds: if the run was stopped and another began meanwhile, this
        // chat belongs to nobody
        if (isAnotherRun(await getBulkSyncState())) return;

        if (dataResponse?.success) {
          log.info(
            `[Bulk Sync] Successfully extracted data for chat ID ${chatId}, sending to worker`,
          );
          const rawPlatformData = dataResponse.data;

          // Derive hostname from provider's list URL
          let currentHostname = "";
          try {
            const listUrl = providerModule.getListUrl(state.baseUrl);
            currentHostname = new URL(listUrl).hostname;
          } catch (err: unknown) {
            log.warn(`[BulkSync] Failed to parse hostname from list URL:`, err);
          }

          // Send to worker for processing (non-blocking). The chat counts as pending until the
          // worker reports on it: the extraction tab stays open for its media downloads.
          const origin = state.platformName === "openwebui" ? state.baseUrl : undefined;
          await addPendingHandoff(chatId);
          try {
            await sendWorkerRequest(
              "bulkSync",
              {
                type: "sync",
                data: {
                  chatId,
                  platformName: state.platformName,
                  hostname: currentHostname,
                  rawData: rawPlatformData,
                  origin,
                  tabId: state.extractionTabId !== null ? state.extractionTabId : undefined,
                  // The worker echoes it, so a report for another run is ignored (HVN-127)
                  runId,
                },
              },
              { expectResponse: false },
            );
          } catch (sendError) {
            await settlePendingHandoff(chatId);
            throw sendError;
          }

          // Track successful processing (Spec 03.02)
          currentState = await getBulkSyncState();
          if (isAnotherRun(currentState)) return;
          if (currentState) {
            state = currentState;
            await setBulkSyncState({
              ...currentState,
              processedChatIds: [...currentState.processedChatIds, chatId],
              lastProgressAt: Date.now(),
            });
          }
        } else {
          const errorMessage = dataResponse?.error || "Unknown error during extraction";
          log.warn(`[Bulk Sync] Could not extract data for chat ID ${chatId}: ${errorMessage}`);
          currentState = await getBulkSyncState();
          if (isAnotherRun(currentState)) return;
          if (currentState) {
            state = currentState;
            await setBulkSyncState({
              ...currentState,
              failedSyncs: [...currentState.failedSyncs, { chatId, error: errorMessage }],
              processedChatIds: [...currentState.processedChatIds, chatId],
              lastProgressAt: Date.now(),
            });
          }
        }
      } catch (error: unknown) {
        // Catch any unexpected errors during fetch and continue with next chat
        const errorMessage =
          error instanceof Error ? error.message : String(error) || "Unknown error during fetch";
        log.error(
          `[Bulk Sync] Unexpected error fetching chat ID ${chatId} (${i + 1}/${state.total}):`,
          error,
        );
        log.error(`[Bulk Sync] Error stack:`, error instanceof Error ? error.stack : undefined);
        currentState = await getBulkSyncState();
        // A resume that began meanwhile owns this chat: it fetches it again
        if (isAnotherRun(currentState)) return;
        if (currentState) {
          state = currentState;
          await setBulkSyncState({
            ...currentState,
            failedSyncs: [...currentState.failedSyncs, { chatId, error: errorMessage }],
            processedChatIds: [...currentState.processedChatIds, chatId],
            lastProgressAt: Date.now(),
          });
        }
      }

      // Update currentIndex for each chat processed (Theory: Race condition fix)
      // We update i+1 immediately so if another tick starts, it sees the new index
      const stateAtEndOfLoop = await getBulkSyncState();
      if (isAnotherRun(stateAtEndOfLoop)) return;
      if (stateAtEndOfLoop) {
        await setBulkSyncState({
          ...stateAtEndOfLoop,
          currentIndex: i + 1,
        });
      }

      // PIPELINING: Start politeness delay but don't await yet
      // This allows the worker to process current chat while we wait for the delay
      // Next iteration will await this delay before fetching, respecting rate limits
      // Use provider's configured rate limit delay, or default based on sync mode
      const syncConfig = providerModule.bulkSyncConfig;
      const usesNavigation = (syncConfig?.mode ?? "navigation") === "navigation";
      const defaultDelay = usesNavigation ? 1000 : 200;
      const delayBetweenChats = syncConfig?.rateLimitDelayMs ?? defaultDelay;

      // Start delay promise for next iteration (don't block this iteration)
      delayPromise = new Promise((resolve) => setTimeout(resolve, delayBetweenChats));

      // Check time limit
      if (Date.now() - startTime >= MAX_TICK_TIME_MS) {
        break;
      }
    }

    // Clear processing flag
    const finalStateForUpdate = await getBulkSyncState();
    if (finalStateForUpdate && !isAnotherRun(finalStateForUpdate)) {
      await setBulkSyncState({
        ...finalStateForUpdate,
        isProcessing: false,
      });
    }

    // Check if we're done
    const finalState = await getBulkSyncState();
    if (isAnotherRun(finalState)) return;
    if (!finalState || finalState.status !== "running") {
      await cleanupBulkSync(finalState);
      return;
    }

    if (finalState.currentIndex >= finalState.total) {
      // Every chat is handed over; clean up once the worker has reported on all of them
      await finishWhenWorkerIdle();
    } else {
      // Schedule next tick
      chrome.alarms.create(BULK_SYNC_ALARM_NAME, {
        when: Date.now() + 100, // 100ms delay
      });
    }
  } finally {
    _tickRunning = false;
    if (_tickSkipped) {
      _tickSkipped = false;
      // Only a run that is still going wants a tick: after the end, an alarm would be a stray one
      const state = await getBulkSyncState();
      if (state?.status === "running") {
        chrome.alarms.create(BULK_SYNC_ALARM_NAME, { when: Date.now() + 100 });
      }
    }
  }
}

let _recheckTimer: ReturnType<typeof setTimeout> | null = null;
let _finishing = false;

/**
 * Cleans up the bulk sync once the worker has reported on every chat handed to it. While one is
 * outstanding it looks again in a few seconds, and the alarm is the backstop for a service worker
 * that is suspended meanwhile. It gives up, and logs it, when the worker has been silent for
 * WORKER_IDLE_GIVE_UP_MS. Called when the last chat is handed over and on each report after that.
 */
async function finishWhenWorkerIdle(): Promise<void> {
  if (_finishing) return;
  _finishing = true;
  try {
    let state = await getBulkSyncState();
    // Only a run whose chats are all handed over finishes here. A stale recheck from a run that was
    // force-reset must not close the next run's tab (Gauge, HVN-123).
    if (!state || state.status === "discovering" || state.currentIndex < state.total) return;
    if (state.status === "running") {
      const pending = await getPendingHandoffs();
      if (pending.chatIds.length > 0) {
        const idleMs = await workerIdleMs();
        if (idleMs < WORKER_IDLE_GIVE_UP_MS) {
          log.info(
            `[Bulk Sync] Waiting for the worker to finish ${pending.chatIds.length} chat(s) before closing the extraction tab`,
          );
          if (_recheckTimer) clearTimeout(_recheckTimer);
          _recheckTimer = setTimeout(() => {
            _recheckTimer = null;
            void finishWhenWorkerIdle();
          }, WORKER_RECHECK_MS);
          chrome.alarms.create(BULK_SYNC_ALARM_NAME, {
            when: Date.now() + WORKER_RECHECK_ALARM_MS,
          });
          return;
        }
        log.warn(
          `[Bulk Sync] Giving up on the worker after ${Math.round(idleMs / 1000)} s of silence; ${pending.chatIds.length} chat(s) never reported: ${pending.chatIds.join(", ")}`,
        );
        // A chat the worker never reported on is not a success: count it as failed.
        const error = `worker never reported (gave up after ${Math.round(idleMs / 1000)} s of silence)`;
        state = {
          ...state,
          failedSyncs: [
            ...state.failedSyncs,
            ...pending.chatIds.map((chatId) => ({ chatId, error })),
          ],
        };
        await setBulkSyncState(state);
      }
    }
    await cleanupBulkSync(state);
  } finally {
    _finishing = false;
  }
}

/** Stop waiting for the worker: for a force-reset, which wipes the state without a cleanup. */
export function stopWaitingForWorker(): void {
  if (_recheckTimer) {
    clearTimeout(_recheckTimer);
    _recheckTimer = null;
  }
}

/**
 * The worker reported on a chat. If that was the last one outstanding and every chat is handed
 * over, the sync finishes. While a tick is still handing chats over, the tick does it.
 */
export async function onWorkerReport(chatId: string): Promise<void> {
  await settlePendingHandoff(chatId);
  if (_tickRunning) return;
  const state = await getBulkSyncState();
  if (state && state.status === "running" && state.currentIndex >= state.total) {
    await finishWhenWorkerIdle();
  }
}

/**
 * Wipes the stored state and then frees the lock, but only for the run that is stored: a state
 * with another `startedAt` is a later run's, and its state and lock are not this ender's to touch.
 * The lock goes last, so no new run can take it while the old state is still there to be wiped
 * (HVN-126). Returns false when the stored state is another run's.
 */
async function wipeAndReleaseIfMine(startedAt: number): Promise<boolean> {
  const stored = await getBulkSyncState();
  if (stored && stored.startedAt !== startedAt) return false;
  await setBulkSyncState(null);
  await releaseOperationLock("bulkSync");
  return true;
}

/**
 * Ends a run that is still looking for its chats, and says so. It has no worker, no index in bulk
 * mode and no alarm, so there is nothing to reset: the start's wait ends when the tab is closed.
 * The state is marked cancelled first, which is how the start knows to leave (HVN-126).
 */
export async function cancelDiscovery(state: BulkSyncState): Promise<void> {
  await setBulkSyncState({ ...state, status: "cancelled", isCancelled: true });
  if (state.extractionTabId !== null) {
    await removeextractionTabBestEffort(state.extractionTabId, "cancel during discovery");
  }
  if (await wipeAndReleaseIfMine(state.startedAt)) {
    safeSendMessage({
      action: "bulkSyncCanceled",
      provider: state.provider,
      baseUrl: state.baseUrl,
      status: "Canceled before any chat was synced.",
    });
  }
}

/**
 * Cleans up bulk sync state and sends completion message. It ends the run it is given: if the
 * stored state is a later run's (an old tick winding down, a Stop that was slow), it leaves it be.
 */
export async function cleanupBulkSync(state: BulkSyncState | null): Promise<void> {
  const stored = await getBulkSyncState();
  if (state && stored && stored.startedAt !== state.startedAt) {
    log.info("[Bulk Sync] Cleanup is for an earlier run; the stored run is not touched");
    if (state.extractionTabId !== null && state.extractionTabId !== stored.extractionTabId) {
      await removeextractionTabBestEffort(state.extractionTabId, "cleanup of an earlier run");
    }
    return;
  }

  if (!state) {
    // Free the lock unless a run has already written its state
    if (!stored) await releaseOperationLock("bulkSync");
    // Still finish indexing in case bulk sync was interrupted
    try {
      await SyncService.finishBulkSyncIndexing();
    } catch (err) {
      log.warn("[Bulk Sync] Failed to finish indexing:", err);
    }
    return;
  }

  if (_recheckTimer) {
    clearTimeout(_recheckTimer);
    _recheckTimer = null;
  }
  await clearPendingHandoffs();

  // Reset worker
  try {
    await sendWorkerRequest("bulkSync", { type: "reset" }, { expectResponse: false });
  } catch (err) {
    log.warn("[Bulk Sync] Failed to reset worker:", err);
  }

  // Clean up extraction tab
  if (state.extractionTabId !== null) {
    await removeextractionTabBestEffort(state.extractionTabId, "final cleanup");
    log.info(`[Bulk Sync] Cleaned up extraction tab ${state.extractionTabId}`);
  }

  // Clear alarm
  chrome.alarms.clear(BULK_SYNC_ALARM_NAME);

  // Rebuild index once at the end (or on error/cancel)
  try {
    await SyncService.finishBulkSyncIndexing();
  } catch (err) {
    log.error("[Bulk Sync] Failed to rebuild index:", err);
    // Continue with cleanup even if index rebuild fails
  }

  // Clear the state from storage, then free the lock. A later run's state is left alone, and so is
  // the report: it is not this run's to make.
  if (!(await wipeAndReleaseIfMine(state.startedAt))) {
    log.info("[Bulk Sync] A later run started during cleanup; leaving its state and lock");
    return;
  }

  // Determine action based on status
  if (state.status === "cancelled") {
    safeSendMessage({
      action: "bulkSyncCanceled",
      provider: state.provider,
      baseUrl: state.baseUrl,
      status: `Canceled after ${state.currentIndex} of ${state.total} chats.`,
    });
  } else if (state.status === "error") {
    safeSendMessage({
      action: "bulkSyncFailed",
      provider: state.provider,
      baseUrl: state.baseUrl,
      error: "Bulk sync failed",
    });
  } else {
    // completed or running (shouldn't happen, but handle gracefully)
    const successCount = state.total - state.failedSyncs.length;
    let statusMessage =
      state.total > 0
        ? `Successfully synced ${successCount} of ${state.total} chats.`
        : "No new chats to sync.";
    if (state.skippedCount > 0) {
      statusMessage += ` ${state.skippedCount} skipped.`;
    }
    if (state.failedSyncs.length > 0) {
      statusMessage += ` ${state.failedSyncs.length} failed.`;
    }

    safeSendMessage({
      action: "bulkSyncComplete",
      provider: state.provider,
      baseUrl: state.baseUrl,
      status: statusMessage,
      failedCount: state.failedSyncs.length,
      skippedCount: state.skippedCount,
      successCount,
      totalCount: state.total,
    });
  }
}

/**
 * Cancels the sync worker if it's running
 */
export async function cancelSyncWorker(): Promise<void> {
  try {
    await sendWorkerRequest("bulkSync", { type: "cancel" }, { expectResponse: false });
  } catch (err) {
    log.warn("[BulkSync] Failed to cancel worker:", err);
  }
}

/**
 * Resumes an incomplete bulk sync operation (Spec 03.02).
 */
export async function resumeBulkSync(provider: string): Promise<void> {
  const state = await getBulkSyncState();
  // A run still discovering has no chat list to resume from (HVN-126)
  if (!state || state.provider !== provider || state.status === "discovering") {
    safeSendMessage({
      action: "bulkSyncFailed",
      provider,
      error: "No incomplete sync found for this provider",
    });
    return;
  }

  // Try to acquire operation lock
  const lockAcquired = await acquireOperationLock("bulkSync");
  if (!lockAcquired) {
    const activeOp = await getActiveOperation();
    safeSendMessage({
      action: "bulkSyncFailed",
      provider,
      error: `Cannot resume bulk sync while ${activeOp} is in progress. Wait for it to complete first.`,
    });
    return;
  }

  try {
    const providerModule = getProvider(provider);
    if (!providerModule) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    // Recreate extraction tab on resume. The previous tab may have become invalid
    // across service worker restarts/reloads.
    const listUrl = providerModule.getListUrl(state.baseUrl);
    if (!listUrl) {
      throw new Error("Provider does not support bulk sync");
    }

    const useForegroundextractionTab =
      provider === "gemini" || !!providerModule.bulkSyncConfig?.requiresActiveTab;
    const extractionTabId = await createExtractionTab(listUrl, {
      active: useForegroundextractionTab,
    });

    // The state and the hand-offs are read now, after the slow part (the tab), and written back at
    // once: a report that landed meanwhile (the worker outlives the service worker) is in what is read.
    // A run that was stopped or replaced meanwhile is not revived: whoever ended it freed the lock
    // and sent the message, so the resume closes its tab and leaves (HVN-126).
    const current = await getBulkSyncState();
    // A Stop that has marked it cancelled but not yet wiped it keeps its startedAt: not resumable
    if (
      !current ||
      current.startedAt !== state.startedAt ||
      (current.status !== "running" && current.status !== "paused")
    ) {
      log.info("[BulkSync] The run was stopped while it resumed; closing the new tab and leaving");
      await removeextractionTabBestEffort(extractionTabId, "resume of a run that was stopped");
      return;
    }

    // Best-effort cleanup of previous extraction tab from interrupted run.
    if (state.extractionTabId !== null && state.extractionTabId !== extractionTabId) {
      await removeextractionTabBestEffort(state.extractionTabId, "resume cleanup");
    }

    const pending = await getPendingHandoffs();
    const plan = planResume(current, pending.chatIds);

    log.info("[BulkSync] Resuming sync", {
      provider,
      total: plan.total,
      settled: plan.currentIndex,
      refetching: plan.refetched.length,
      remaining: plan.total - plan.currentIndex,
    });

    // The chats the worker had been handed are fetched again (the plan put them back in the list),
    // so nothing is waited for, and the worker's reports from before the restart are another leg's.
    await clearPendingHandoffs();

    await setBulkSyncState({
      ...current,
      chatIds: plan.chatIds,
      total: plan.total,
      currentIndex: plan.currentIndex,
      processedChatIds: plan.processedChatIds,
      failedSyncs: plan.failedSyncs,
      resumeCount: (current.resumeCount ?? 0) + 1,
      status: "running",
      extractionTabId,
      lastProgressAt: Date.now(),
      isProcessing: false,
      isCancelled: false,
    });

    // Enable bulk sync indexing mode
    await SyncService.startBulkSyncIndexing();

    // Send resume notification
    safeSendMessage({
      action: "bulkSyncStarted",
      provider: state.provider,
      baseUrl: state.baseUrl,
      total: plan.total,
      skippedCount: state.skippedCount,
    });

    // Create alarm to start processing immediately
    chrome.alarms.create(BULK_SYNC_ALARM_NAME, {
      when: Date.now(),
    });

    // Process first batch immediately
    await handleBulkSyncTick();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error("Bulk sync resume failed:", errorMessage, error);
    await setBulkSyncState(null);
    safeSendMessage({
      action: "bulkSyncFailed",
      provider,
      error: errorMessage,
    });
    await releaseOperationLock("bulkSync");
  }
}

/**
 * Legacy function name for backward compatibility.
 * Now delegates to startBulkSync.
 */
export async function handleBulkSync(
  tabId: number,
  provider: string,
  baseUrl: string | undefined,
  options: BulkSyncOptions,
): Promise<void> {
  await startBulkSync(tabId, provider, baseUrl, options);
}
