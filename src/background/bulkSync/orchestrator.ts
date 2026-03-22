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
import { bulkSyncStateManager } from "./stateManager";
import type { BulkSyncOptions, BulkSyncState } from "./types";

export const BULK_SYNC_ALARM_NAME = "bulkSyncAlarm";
const FETCH_BATCH_SIZE = 5; // Fetch 5 chats at once and send to worker
const MAX_TICK_TIME_MS = 25000; // Max 25 seconds per tick to leave buffer for next alarm

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

async function recoverextractionTab(state: BulkSyncState): Promise<BulkSyncState | null> {
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

  if (state.extractionTabId !== null && state.extractionTabId !== newextractionTabId) {
    await removeextractionTabBestEffort(state.extractionTabId, "tab recovery");
  }

  const recoveredState: BulkSyncState = {
    ...state,
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

  // Wrap entire initialization in try-finally to ensure lock is always released on error
  try {
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

    // Create extraction tab pointing to list URL
    const useForegroundextractionTab =
      provider === "gemini" || !!providerModule.bulkSyncConfig?.requiresActiveTab;
    const extractionTabId = await createExtractionTab(listUrl, {
      active: useForegroundextractionTab,
    });

    try {
      // Get chat IDs via content script in tab
      const chatIdsResponse = await chrome.tabs.sendMessage(extractionTabId, {
        action: "getChatIds",
      });

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

        // Cleanup
        await removeextractionTabBestEffort(extractionTabId, "early completion cleanup");

        await releaseOperationLock("bulkSync");
        await setBulkSyncState(null);

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
        status: "running", // New status field
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
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        processedChatIds: [],
      };

      await setBulkSyncState(initialState);

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
    const state = await getBulkSyncState();
    if (!state || state.status !== "running") {
      await releaseOperationLock("bulkSync");
    }
  }
}

// In-memory re-entrancy guard. The storage-based isProcessing flag has a TOCTOU
// race: the alarm macrotask can fire between the storage read (isProcessing=false)
// and the storage write (isProcessing=true), starting a second concurrent tick.
// This module-level flag is checked and set synchronously, eliminating the race.
let _tickRunning = false;

/**
 * Processes one batch of chats (called by alarm listener).
 * Fetches data for up to FETCH_BATCH_SIZE chats and sends to worker for processing.
 */
export async function handleBulkSyncTick(): Promise<void> {
  // Synchronous guard — no await before the check+set, so no race condition
  if (_tickRunning) {
    log.debug("[Bulk Sync] Tick already running in this context, skipping.");
    return;
  }
  _tickRunning = true;

  try {
  let state = await getBulkSyncState();
  // Check for termination conditions: no state, or not in 'running' state
  if (!state || state.status !== "running") {
    await cleanupBulkSync(state);
    return;
  }

  if (state.currentIndex >= state.total) {
    await cleanupBulkSync(state);
    return;
  }

  // Keep storage flag in sync for cross-session stale-state detection
  await setBulkSyncState({ ...state, isProcessing: true });

  // Re-fetch state
  const processingState = await getBulkSyncState();
  if (!processingState || processingState.status !== "running") {
    return;
  }
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
    }

    // Check if extraction tab is still valid
    if (state.extractionTabId === null) {
      log.warn("[Bulk Sync] extraction tab ID missing. Attempting recovery.");
      const recoveredState = await recoverextractionTab(state);
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

        // Send to worker for processing (non-blocking)
        const origin = state.platformName === "openwebui" ? state.baseUrl : undefined;
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
            },
          },
          { expectResponse: false },
        );

        // Track successful processing (Spec 03.02)
        currentState = await getBulkSyncState();
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
  if (finalStateForUpdate) {
    await setBulkSyncState({
      ...finalStateForUpdate,
      isProcessing: false,
    });
  }

  // Check if we're done
  const finalState = await getBulkSyncState();
  if (!finalState || finalState.status !== "running") {
    await cleanupBulkSync(finalState);
    return;
  }

  if (finalState.currentIndex >= finalState.total) {
    // Wait a bit for worker to finish processing remaining tasks
    // Then cleanup
    setTimeout(async () => {
      const checkState = await getBulkSyncState();
      if (checkState && checkState.currentIndex >= checkState.total) {
        await cleanupBulkSync(checkState);
      }
    }, 2000);
  } else {
    // Schedule next tick
    chrome.alarms.create(BULK_SYNC_ALARM_NAME, {
      when: Date.now() + 100, // 100ms delay
    });
  }
  } finally {
    _tickRunning = false;
  }
}

/**
 * Cleans up bulk sync state and sends completion message.
 */
export async function cleanupBulkSync(state: BulkSyncState | null): Promise<void> {
  // Release operation lock first
  await releaseOperationLock("bulkSync");

  if (!state) {
    // Still finish indexing in case bulk sync was interrupted
    try {
      await SyncService.finishBulkSyncIndexing();
    } catch (err) {
      log.warn("[Bulk Sync] Failed to finish indexing:", err);
    }
    return;
  }

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

  // CRITICAL: Clear the state from storage
  await setBulkSyncState(null);
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
  if (!state || state.provider !== provider) {
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

    // Get remaining chats
    const remainingChatIds = await bulkSyncStateManager.getRemainingChatIds();

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

    // Best-effort cleanup of previous extraction tab from interrupted run.
    if (state.extractionTabId !== null && state.extractionTabId !== extractionTabId) {
      await removeextractionTabBestEffort(state.extractionTabId, "resume cleanup");
    }

    log.info("[BulkSync] Resuming sync", {
      provider,
      total: state.total,
      processed: state.processedChatIds.length,
      remaining: remainingChatIds.length,
    });

    // Update state to resume with remaining chats
    await setBulkSyncState({
      ...state,
      chatIds: remainingChatIds,
      currentIndex: 0, // Reset index for remaining chats
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
      total: state.total,
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
