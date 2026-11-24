// Shared state management for bulk sync and bulk export operations
// Uses storage adapter for persistence across service worker restarts

import { getStorageAdapter } from "../storage";
import { log } from "../utils/logger";
import type { BulkExportState } from "./bulkExport/types";
import type { BulkSyncState } from "./bulkSync/types";
import { getExportJobState, setExportJobState } from "./export/exportState";
import { safeSendMessage } from "./utils/messageUtils";

const BULK_SYNC_STATE_KEY = "bulkSyncState";
const BULK_EXPORT_STATE_KEY = "bulkExportState";

export async function getBulkSyncState(): Promise<BulkSyncState | null> {
  const storage = getStorageAdapter();
  const state = await storage.get<BulkSyncState>(BULK_SYNC_STATE_KEY);
  if (!state) return null;

  // Ensure backward compatibility: if extractionTabId doesn't exist, default to null
  if (state.extractionTabId === undefined) {
    state.extractionTabId = null;
  }

  return state;
}

export async function setBulkSyncState(state: BulkSyncState | null): Promise<void> {
  const storage = getStorageAdapter();
  if (state === null) {
    await storage.remove(BULK_SYNC_STATE_KEY);
  } else {
    await storage.set(BULK_SYNC_STATE_KEY, state);
  }
}

// Legacy compatibility wrapper for existing code that uses BulkSyncState object
// This will be removed once all code is migrated to use getBulkSyncState/setBulkSyncState
export const BulkSyncStateHelper = {
  getCancelRequested: async (): Promise<boolean> => {
    const state = await getBulkSyncState();
    return state?.isCancelled ?? false;
  },
  setCancelRequested: async (value: boolean): Promise<void> => {
    const state = await getBulkSyncState();
    if (state) {
      await setBulkSyncState({ ...state, isCancelled: value });
    }
  },
  getCurrentSyncProvider: async (): Promise<string | null> => {
    const state = await getBulkSyncState();
    return state?.provider ?? null;
  },
  setCurrentSyncProvider: async (value: string | null): Promise<void> => {
    const state = await getBulkSyncState();
    if (state) {
      await setBulkSyncState({ ...state, provider: value ?? "" });
    }
  },
  getSyncTabId: async (): Promise<number | null> => {
    const state = await getBulkSyncState();
    return state?.tabId ?? null;
  },
  setSyncTabId: async (value: number | null): Promise<void> => {
    const state = await getBulkSyncState();
    if (state) {
      await setBulkSyncState({ ...state, tabId: value ?? 0 });
    }
  },
  addFailedSync: async (chatId: string, error: string): Promise<void> => {
    const state = await getBulkSyncState();
    if (state) {
      await setBulkSyncState({
        ...state,
        failedSyncs: [...state.failedSyncs, { chatId, error }],
      });
    }
  },
  getFailedSyncs: async (): Promise<Array<{ chatId: string; error: string }>> => {
    const state = await getBulkSyncState();
    return state?.failedSyncs ?? [];
  },
  reset: async (): Promise<void> => {
    await setBulkSyncState(null);
  },
};

// Cancel bulk sync by updating status. A run still discovering its chats has no worker, no index in
// bulk mode and no alarm, so it is ended by `cancelDiscovery`: the tab is closed (which ends the
// pending `getChatIds`), and the start sees its state is no longer its own discovery and leaves the
// clean-up to it (HVN-126).
export async function cancelBulkSync(): Promise<void> {
  const state = await getBulkSyncState();
  if (state?.status === "discovering") {
    const { cancelDiscovery } = await import("./bulkSync/bulkSync");
    await cancelDiscovery(state);
    return;
  }
  if (state && state.status === "running") {
    const newState = {
      ...state,
      status: "cancelled" as const,
      isCancelled: true,
    };
    await setBulkSyncState(newState);

    // 1. Kill extraction tab immediately to break any pending navigation/extraction
    if (state.extractionTabId !== null) {
      try {
        await chrome.tabs.remove(state.extractionTabId);
      } catch (_e) {
        // Tab might already be closed, ignore
      }
    }

    // 2. Cancel the worker immediately
    // Dynamic import to avoid circular dependency
    const { cancelSyncWorker, cleanupBulkSync, BULK_SYNC_ALARM_NAME } = await import(
      "./bulkSync/bulkSync"
    );
    cancelSyncWorker();

    // 3. Clear any pending alarms to prevent interference
    chrome.alarms.clear(BULK_SYNC_ALARM_NAME);

    // 4. Directly call cleanup instead of relying on alarm
    // Re-fetch state to ensure we have the cancelled status
    const cancelledState = await getBulkSyncState();
    await cleanupBulkSync(cancelledState);
  }
}

// Bulk Export State Management
export async function getBulkExportState(): Promise<BulkExportState | null> {
  const storage = getStorageAdapter();
  return await storage.get<BulkExportState>(BULK_EXPORT_STATE_KEY);
}

export async function setBulkExportState(state: BulkExportState | null): Promise<void> {
  const storage = getStorageAdapter();
  if (state === null) {
    await storage.remove(BULK_EXPORT_STATE_KEY);
  } else {
    await storage.set(BULK_EXPORT_STATE_KEY, state);
  }
}

// Operation Lock Management - Prevents concurrent operations
// This ensures only one operation (bulkSync, import, or bulkExport) runs at a time
const ACTIVE_OPERATION_KEY = "activeOperation";

export type ActiveOperation = "idle" | "bulkSync" | "import" | "bulkExport" | "providerHealth";

export async function getActiveOperation(): Promise<ActiveOperation> {
  const storage = getStorageAdapter();
  const result = await storage.get<ActiveOperation>(ACTIVE_OPERATION_KEY);
  return result || "idle";
}

export async function setActiveOperation(operation: ActiveOperation): Promise<void> {
  const storage = getStorageAdapter();
  await storage.set(ACTIVE_OPERATION_KEY, operation);
}

// Single-chat syncs (the popup's and the CLI's) take no operation lock: they are short, and they
// run beside one another. The Janitor must still know one is running, because a sync writes a
// chat's media before its row (HVN-146). The count lives in the service worker's memory on
// purpose: a sync does not outlive the worker, so neither should its count.
let singleSyncs = 0;

// A count of what is running now cannot say that a writer came and went. This one only grows: it
// moves whenever something that writes chats begins (an operation lock taken, a single sync
// started), so a reader that noted it earlier can tell that something has begun since, however
// short its run (HVN-146).
let writersGeneration = 0;

/** The generation of chat writers: it moves each time an operation lock is taken or a single sync begins. */
export function chatWritersGeneration(): number {
  return writersGeneration;
}

/** A single-chat sync starts. Pair it with {@link endSingleSync} in a `finally`. */
export function beginSingleSync(): void {
  writersGeneration += 1;
  singleSyncs += 1;
}

/** A single-chat sync ends, however it ended. */
export function endSingleSync(): void {
  singleSyncs = Math.max(0, singleSyncs - 1);
}

/** How many single-chat syncs are running now. */
export function singleSyncsInFlight(): number {
  return singleSyncs;
}

/**
 * Attempts to acquire the operation lock.
 * @param operation The operation requesting the lock
 * @returns true if lock was acquired, false if another operation is active
 */
export async function acquireOperationLock(operation: ActiveOperation): Promise<boolean> {
  const current = await getActiveOperation();
  if (current !== "idle") {
    log.warn(`Cannot start ${operation}: ${current} is active`);
    return false;
  }
  // Before the lock is written: a reader never sees the lock without the new generation
  writersGeneration += 1;
  await setActiveOperation(operation);
  log.info(`Operation lock acquired: ${operation}`);
  return true;
}

/**
 * Releases the operation lock, allowing other operations to start.
 * @param operation Optional - the operation releasing the lock (for validation)
 */
export async function releaseOperationLock(operation?: ActiveOperation): Promise<void> {
  const current = await getActiveOperation();

  // If operation is specified, validate ownership before releasing
  if (operation && current !== operation && current !== "idle") {
    log.warn(
      `Operation lock release mismatch: ${operation} tried to release but ${current} holds the lock`,
    );
    return; // Don't release if we don't own the lock
  }

  log.info(`Operation lock released: ${current}`);
  await setActiveOperation("idle");
}

/**
 * Clears any stale operation locks and resets operation states on startup.
 * Should be called during extension initialization.
 */
export async function clearStaleOperationLocks(): Promise<void> {
  const current = await getActiveOperation();
  if (current !== "idle") {
    log.warn(`Clearing stale operation lock: ${current}`);
    await setActiveOperation("idle");
  }

  // Also clean up detailed states.
  // NOTE: Bulk sync is resumable and should NOT be force-cancelled here.
  try {
    const syncState = await getBulkSyncState();
    if (syncState && syncState.status === "discovering") {
      // Its start died with the service worker, and it has no chat list to resume from: drop it,
      // close the tab it was reading, and tell any open page so its Stop button does not linger.
      log.warn("Found a bulk sync that was still discovering its chats, dropping it");
      if (syncState.extractionTabId !== null) {
        try {
          await chrome.tabs.remove(syncState.extractionTabId);
        } catch (_e) {
          // The tab is already gone
        }
      }
      await setBulkSyncState(null);
      safeSendMessage({
        action: "bulkSyncFailed",
        provider: syncState.provider,
        baseUrl: syncState.baseUrl,
        error:
          "Bulk sync stopped while it was looking for chats: the extension restarted. Start it again.",
      });
    } else if (syncState && syncState.status === "running") {
      log.warn("Found interrupted bulk sync state, preserving for resume");
      await setBulkSyncState({
        ...syncState,
        isCancelled: false,
        isProcessing: false,
      });
    }

    const exportState = await getBulkExportState();
    if (exportState && exportState.status === "running") {
      log.warn("Resetting stale bulk export state from 'running' to 'error'");
      await setBulkExportState({
        ...exportState,
        status: "error",
      });
    }

    const exportJobState = await getExportJobState();
    if (exportJobState && exportJobState.status === "running") {
      log.warn("Resetting stale export job state from 'running' to 'cancelled'");
      await setExportJobState({
        ...exportJobState,
        status: "cancelled",
        error: "Export interrupted by extension restart",
        lastCheckpointAt: Date.now(),
      });
    }
  } catch (err) {
    log.error("Failed to clear stale operation states:", err);
  }
}
