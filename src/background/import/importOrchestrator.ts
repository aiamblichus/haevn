/**
 * Import Orchestrator - Service Worker coordinator for import operations
 *
 * Manages the import worker lifecycle and handles browser API calls on behalf of the worker.
 * Uses the CRD-003 pattern: worker does processing, service worker handles browser APIs.
 */

import { CacheService } from "../../services/cacheService";
import type { SaveChatResult } from "../../services/chatPersistence";
import { queueGeneration } from "../../services/metadataService";
import { getMetadataAIConfig } from "../../services/settingsService";
import { SyncService } from "../../services/syncService";
import { getStorageAdapter } from "../../storage";
import type { ImportSourceType, ImportWorkerResponse } from "../../types/workerMessages";
import { fireAndForget } from "../../utils/error_utils";
import { log } from "../../utils/logger";
import { sendWorkerRequest } from "../../utils/workerApi";
import { handleGenerateThumbnails } from "../handlers/galleryHandlers";
import { acquireOperationLock, getActiveOperation, releaseOperationLock } from "../state";
import { safeSendMessage } from "../utils/messageUtils";
import { ensureOffscreenDocument } from "../utils/offscreenUtils";

// Three-Tier Architecture: Service Worker → Offscreen Document → Web Worker
// The offscreen document creates and manages the import worker
// We route messages through the unified worker API with progress callbacks

// Import job state (stored via storage adapter for resumability)
interface ImportJobState {
  status: "running" | "paused" | "cancelled" | "complete" | "error";
  importType: ImportSourceType;
  totalChats: number;
  processedChats: number;
  savedChats: number;
  skippedChats: number;
  processedMedia?: number;
  totalMedia?: number;
  bytesWritten?: number;
  totalBytes?: number;
  phase?: "counting" | "manifest" | "chats" | "media" | "index";
  startTime: number;
  lastUpdateTime: number;
  stagedFilePath?: string;
  originalFileName?: string;
  originalFileType?: string;
  error?: string;
}

const IMPORT_STATE_KEY = "import_job_state";

/**
 * Get current import job state from storage
 */
export async function getImportJobState(): Promise<ImportJobState | null> {
  try {
    const storage = getStorageAdapter();
    return await storage.get<ImportJobState>(IMPORT_STATE_KEY);
  } catch (error) {
    log.error("[ImportOrchestrator] Failed to get import state:", error);
    return null;
  }
}

/**
 * Save import job state to storage
 */
async function saveImportJobState(state: ImportJobState): Promise<void> {
  try {
    const storage = getStorageAdapter();
    await storage.set(IMPORT_STATE_KEY, state);
  } catch (error) {
    log.error("[ImportOrchestrator] Failed to save import state:", error);
  }
}

/**
 * Clear import job state from storage
 */
async function clearImportJobState(): Promise<void> {
  try {
    const storage = getStorageAdapter();
    await storage.remove(IMPORT_STATE_KEY);
  } catch (error) {
    log.error("[ImportOrchestrator] Failed to clear import state:", error);
  }
}

/**
 * Clears any stale import state on startup.
 */
export async function clearStaleImportState(): Promise<void> {
  const state = await getImportJobState();
  if (state && state.status === "running") {
    log.warn("[ImportOrchestrator] Clearing stale import job from 'running' state");
    await clearImportJobState();
  }
}

async function requestDeleteStagedFile(path?: string): Promise<void> {
  if (!path) return;
  await ensureOffscreenDocument();
  await new Promise<void>((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "deleteStagedFile", path },
      (response?: { success: boolean; error?: string }) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response?.success) {
          reject(new Error(response?.error || "Failed to delete staged file"));
          return;
        }
        resolve();
      },
    );
  }).catch((err) => {
    log.warn(`[ImportOrchestrator] Failed to delete staged file ${path}:`, err);
  });
}

/**
 * Handle post-processing request from worker
 * Updates cache, search index, and triggers thumbnail generation
 */
async function handlePostProcess(
  chatId: string,
  result: SaveChatResult,
  isNewChat: boolean,
): Promise<void> {
  try {
    // Derive platform name from source
    const source = result.source?.toLowerCase() || "";
    let platformName: string | undefined;

    if (source.includes("openwebui")) {
      platformName = "openwebui";
    } else if (source.includes("gemini")) {
      platformName = "gemini";
    } else if (source.includes("claudecode")) {
      platformName = "claudecode";
    } else if (source.includes("claude")) {
      platformName = "claude";
    } else if (source.includes("codex")) {
      platformName = "codex";
    } else if (source.includes("pi")) {
      platformName = "pi";
    } else if (source.includes("poe")) {
      platformName = "poe";
    } else if (source.includes("chatgpt")) {
      platformName = "chatgpt";
    } else if (source.includes("qwen")) {
      platformName = "qwen";
    } else if (source.includes("aistudio")) {
      platformName = "aistudio";
    } else if (source.includes("grok")) {
      platformName = "grok";
    }

    // Update sync status cache
    if (result.source && result.sourceId) {
      try {
        await CacheService.setSyncStatus(result.source, result.sourceId, true, chatId);
      } catch (err) {
        log.error("[ImportOrchestrator] Failed to update sync status cache:", err);
      }
    }

    // Update provider stats cache (increment for new chats)
    if (isNewChat && platformName) {
      try {
        await CacheService.updateProviderStats(platformName, 1);
      } catch (err) {
        log.error("[ImportOrchestrator] Failed to update provider stats:", err);
      }
    }

    // Note: Search indexing is handled in bulk mode at the end of import
    // No need to index individual chats here - the entire index will be rebuilt once

    // Generate thumbnails (fire-and-forget)
    handleGenerateThumbnails(chatId).catch((err) => {
      log.warn(`[ImportOrchestrator] Failed to generate thumbnails for ${chatId}:`, err);
    });

    // Queue AI metadata generation if enabled and autoGenerate is on
    getMetadataAIConfig()
      .then((config) => {
        if (config.enabled && config.autoGenerate) {
          return queueGeneration(chatId);
        }
      })
      .catch((err) => {
        log.warn(`[ImportOrchestrator] Failed to queue metadata generation for ${chatId}:`, err);
      });

    // Broadcast chat synced event
    safeSendMessage({
      action: "chatSynced",
      meta: {
        id: chatId,
        source: result.source || "unknown",
        title: result.title,
        lastSyncedTimestamp: result.lastSyncedTimestamp || Date.now(),
        syncStatus:
          (result.syncStatus as "synced" | "changed" | "error" | "pending" | "new") || "synced",
        providerLastModifiedTimestamp: result.providerLastModifiedTimestamp,
        lastSyncAttemptMessage: result.lastSyncAttemptMessage,
      },
    });
  } catch (error) {
    log.error(`[ImportOrchestrator] Error in post-processing for ${chatId}:`, error);
  }
}

/**
 * Handle worker response messages
 */
export async function handleWorkerResponse(response: ImportWorkerResponse): Promise<void> {
  const state = await getImportJobState();
  if (!state) {
    log.warn("[ImportOrchestrator] No active import job state");
    return;
  }

  try {
    switch (response.type) {
      case "progress": {
        // Update state
        state.processedChats = response.processed;
        state.totalChats = response.total;
        if (response.processedMedia !== undefined) {
          state.processedMedia = response.processedMedia;
        }
        if (response.totalMedia !== undefined) {
          state.totalMedia = response.totalMedia;
        }
        if (response.bytesWritten !== undefined) {
          state.bytesWritten = response.bytesWritten;
        }
        if (response.totalBytes !== undefined) {
          state.totalBytes = response.totalBytes;
        }
        if (response.phase) {
          state.phase = response.phase;
        }
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);

        // Broadcast progress to UI
        safeSendMessage({
          action: "importProgress",
          processed: response.processed,
          total: response.total,
          saved: state.savedChats,
          skipped: state.skippedChats,
          status: response.status,
          phase: response.phase,
          processedMedia: state.processedMedia,
          totalMedia: state.totalMedia,
          bytesWritten: state.bytesWritten,
          totalBytes: state.totalBytes,
        });
        break;
      }

      case "saved": {
        state.savedChats++;
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);
        break;
      }

      case "skipped": {
        state.skippedChats++;
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);
        // Log the skip reason for debugging
        log.warn(
          `[ImportOrchestrator] Chat skipped: ${response.chatId || "unknown"}`,
          `Reason: ${response.reason || "Unknown"}`,
        );
        break;
      }

      case "postProcess": {
        // Handle post-processing in background (don't block worker)
        handlePostProcess(response.chatId, response.result, response.isNewChat).catch((err) => {
          log.error(`[ImportOrchestrator] Post-processing failed for ${response.chatId}:`, err);
        });
        break;
      }

      case "complete": {
        state.status = "complete";
        state.phase = "index";
        state.processedChats = response.processed;
        state.savedChats = response.saved;
        state.skippedChats = response.skipped;
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);
        fireAndForget(
          requestDeleteStagedFile(state.stagedFilePath),
          "Cleanup staged import file after completion",
        );

        // Release operation lock
        await releaseOperationLock("import");

        // Finish bulk indexing - rebuild index once with all imported chats
        log.info("[ImportOrchestrator] Finishing bulk indexing mode");
        safeSendMessage({
          action: "importProgress",
          processed: response.processed,
          total: state.totalChats,
          saved: response.saved,
          skipped: response.skipped,
          status: "Finalizing index...",
          phase: "index",
          processedMedia: state.processedMedia,
          totalMedia: state.totalMedia,
          bytesWritten: state.bytesWritten,
          totalBytes: state.totalBytes,
        });
        try {
          await SyncService.finishBulkSyncIndexing();
        } catch (err) {
          log.error("[ImportOrchestrator] Failed to finish bulk indexing:", err);
        }

        // Broadcast completion
        safeSendMessage({
          action: "importComplete",
          processed: response.processed,
          saved: response.saved,
          skipped: response.skipped,
        });

        // Clear state after a delay
        setTimeout(() => clearImportJobState(), 5000);
        break;
      }

      case "error": {
        state.status = "error";
        state.error = response.error;
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);
        fireAndForget(
          requestDeleteStagedFile(state.stagedFilePath),
          "Cleanup staged import file after error",
        );

        // Release operation lock
        await releaseOperationLock("import");

        // Finish bulk indexing even on error to rebuild index with partial imports
        log.info("[ImportOrchestrator] Finishing bulk indexing mode (error)");
        try {
          await SyncService.finishBulkSyncIndexing();
        } catch (err) {
          log.error("[ImportOrchestrator] Failed to finish bulk indexing:", err);
        }

        // Broadcast error
        safeSendMessage({
          action: "importFailed",
          error: response.error,
        });

        // Clear state after a delay
        setTimeout(() => clearImportJobState(), 5000);
        break;
      }

      case "paused": {
        state.status = "paused";
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);

        safeSendMessage({
          action: "importPaused",
        });
        break;
      }

      case "cancelled": {
        state.status = "cancelled";
        state.lastUpdateTime = Date.now();
        await saveImportJobState(state);
        fireAndForget(
          requestDeleteStagedFile(state.stagedFilePath),
          "Cleanup staged import file after cancellation",
        );

        // Release operation lock
        await releaseOperationLock("import");

        // Finish bulk indexing on cancellation to rebuild index with partial imports
        log.info("[ImportOrchestrator] Finishing bulk indexing mode (cancelled)");
        try {
          await SyncService.finishBulkSyncIndexing();
        } catch (err) {
          log.error("[ImportOrchestrator] Failed to finish bulk indexing:", err);
        }

        safeSendMessage({
          action: "importCancelled",
          processed: state.processedChats,
          saved: state.savedChats,
          skipped: state.skippedChats,
        });

        // Clear state after a delay
        setTimeout(() => clearImportJobState(), 5000);
        break;
      }

      case "count": {
        // Count responses don't update job state
        // They're handled directly by the caller
        break;
      }

      case "requestBrowserAPI": {
        // CRD-003: Handle browser API requests from worker
        log.warn(
          `[ImportOrchestrator] Worker requested browser API: ${response.api} (not implemented)`,
        );
        // TODO: Implement browser API bridge if needed
        break;
      }

      default: {
        const exhaustiveCheck: never = response;
        log.warn("[ImportOrchestrator] Unknown response type:", exhaustiveCheck);
      }
    }
  } catch (error) {
    log.error("[ImportOrchestrator] Error handling worker response:", error);
  }
}

/**
 * Start an import job
 */
export async function startImportJob(
  importType: ImportSourceType,
  stagedFilePath: string,
  options: {
    originalFileName?: string;
    originalFileType?: string;
    overwriteExisting: boolean;
  },
): Promise<void> {
  // Try to acquire operation lock
  const lockAcquired = await acquireOperationLock("import");
  if (!lockAcquired) {
    const activeOp = await getActiveOperation();
    throw new Error(`Cannot start import: ${activeOp} is currently in progress.`);
  }

  try {
    // Initialize job state
    const state: ImportJobState = {
      status: "running",
      importType,
      totalChats: 0,
      processedChats: 0,
      savedChats: 0,
      skippedChats: 0,
      processedMedia: 0,
      totalMedia: 0,
      bytesWritten: 0,
      totalBytes: 0,
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      stagedFilePath,
      originalFileName: options.originalFileName,
      originalFileType: options.originalFileType,
    };
    await saveImportJobState(state);

    // Enable bulk indexing mode for efficient import
    log.info("[ImportOrchestrator] Enabling bulk indexing mode");
    await SyncService.startBulkSyncIndexing();

    // Start the worker with progress handler
    // Use fireAndForget so the function returns immediately but progress continues
    fireAndForget(
      sendWorkerRequest(
        "import",
        {
          type: "start",
          importType,
          stagedFilePath,
          originalFileName: options.originalFileName,
          originalFileType: options.originalFileType,
          overwriteExisting: options.overwriteExisting,
        },
        {
          onProgress: handleWorkerResponse,
          timeout: 600000, // 10 minutes for large imports
        },
      ),
      "Import job progress monitoring",
    );
  } finally {
    // Always release lock if we hit an error during initialization
    // Note: On success, the lock is held and released in handleWorkerResponse()
    const state = await getImportJobState();
    if (!state || state.status !== "running") {
      await releaseOperationLock("import");
    }
  }
}

/**
 * Pause the current import job
 */
export async function pauseImportJob(): Promise<void> {
  const state = await getImportJobState();
  if (!state || state.status !== "running") {
    throw new Error("No active import job to pause");
  }

  await sendWorkerRequest("import", { type: "pause" }, { expectResponse: false });
}

/**
 * Resume a paused import job
 */
export async function resumeImportJob(): Promise<void> {
  const state = await getImportJobState();
  if (!state || state.status !== "paused") {
    throw new Error("No paused import job to resume");
  }

  await sendWorkerRequest("import", { type: "resume" }, { expectResponse: false });
}

/**
 * Cancel the current import job
 */
export async function cancelImportJob(): Promise<void> {
  const state = await getImportJobState();
  if (!state || (state.status !== "running" && state.status !== "paused")) {
    throw new Error("No active import job to cancel");
  }

  await sendWorkerRequest("import", { type: "cancel" }, { expectResponse: false });
}

/**
 * Count conversations in an import file
 */
export async function countImportConversations(
  importType: ImportSourceType,
  stagedFilePath: string,
  options?: { originalFileName?: string; originalFileType?: string },
): Promise<number> {
  const result = await sendWorkerRequest(
    "import",
    {
      type: "count",
      importType,
      stagedFilePath,
      originalFileName: options?.originalFileName,
      originalFileType: options?.originalFileType,
    },
    { timeout: 30000 },
  );

  if (!result || result.type !== "count") {
    throw new Error("Invalid count response from import worker");
  }

  return result.count;
}
