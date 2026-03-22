// Shared state management for bulk sync and bulk export operations
// Uses storage adapter for persistence across service worker restarts

import { getStorageAdapter } from "../storage";
import { log } from "../utils/logger";
import type { BulkExportState } from "./bulkExport/types";
import type { BulkSyncState } from "./bulkSync/types";
import { getExportJobState, setExportJobState } from "./export/exportState";

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

// Cancel bulk sync by updating status
export async function cancelBulkSync(): Promise<void> {
  const state = await getBulkSyncState();
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

export type ActiveOperation = "idle" | "bulkSync" | "import" | "bulkExport";

export async function getActiveOperation(): Promise<ActiveOperation> {
  const storage = getStorageAdapter();
  const result = await storage.get<ActiveOperation>(ACTIVE_OPERATION_KEY);
  return result || "idle";
}

export async function setActiveOperation(operation: ActiveOperation): Promise<void> {
  const storage = getStorageAdapter();
  await storage.set(ACTIVE_OPERATION_KEY, operation);
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
    if (syncState && syncState.status === "running") {
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
