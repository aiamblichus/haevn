// Bulk export orchestration
// Refactored to use Web Worker for CPU-intensive processing
// Service worker coordinates between UI and worker, handles browser APIs
//
// CRD-003: Service Worker as Browser API Bridge
// This module implements the pattern where the service worker acts as a lightweight
// bridge, handling all browser API calls (e.g., chrome.downloads) on behalf of workers.
// Workers cannot access Chrome APIs directly, so they send requests to the service worker
// which executes the API calls and sends responses back.

import type { ExportOptions } from "../../formatters";
import { ExportManifestWriter } from "../../services/exportManifest";
import { buildExportStagingRoot, buildExportZipPath } from "../../services/exportStaging";
import type { BulkExportWorkerResponse } from "../../types/workerMessages";
import { fireAndForget } from "../../utils/error_utils";
import { log } from "../../utils/logger";
import { withTimeout } from "../../utils/timeout_utils";
import { sendWorkerRequest } from "../../utils/workerApi";
import { getExportJobState, setExportJobState } from "../export/exportState";
import {
  acquireOperationLock,
  getActiveOperation,
  getBulkExportState,
  releaseOperationLock,
  setBulkExportState,
} from "../state";
import { safeSendMessage } from "../utils/messageUtils";
import {
  createBlobUrlFromOffscreen,
  ensureOffscreenDocument,
  revokeBlobUrlFromOffscreen,
} from "../utils/offscreenUtils";
// Removed downloadManager import - using chrome.downloads.download directly
import type { BulkExportState } from "./types";

// Three-Tier Architecture: Service Worker → Offscreen Document → Web Worker
// The offscreen document creates and manages the bulkExport worker
// We route messages through the unified worker API with progress callbacks

/**
 * Handle messages from the worker
 *
 * CRD-003: Implements request/response pattern for browser API access.
 * Workers send requests (e.g., "requestDownload") and receive responses
 * (e.g., "downloadComplete") with matching requestId for correlation.
 */
async function handleWorkerMessage(message: BulkExportWorkerResponse): Promise<void> {
  log.info(`[BulkExport] handleWorkerMessage received:`, {
    type: message.type,
    hasRequestId: "requestId" in message,
  });
  const state = await getBulkExportState();
  if (!state) {
    log.warn("[BulkExport] Received worker message but no state exists");
    return;
  }

  switch (message.type) {
    case "progress": {
      // Update state and forward progress to UI
      const nextBatchNumber =
        message.currentBatch !== undefined ? message.currentBatch : state.currentBatchNumber;
      await setBulkExportState({
        ...state,
        processedChats: message.processed,
        currentBatchNumber: nextBatchNumber,
      });
      const exportState = await getExportJobState();
      if (exportState) {
        await setExportJobState({
          ...exportState,
          processedChats: message.processed,
          processedMedia: message.processedMedia ?? exportState.processedMedia,
          bytesWritten: message.bytesWritten ?? exportState.bytesWritten,
          lastCheckpointAt: Date.now(),
        });
      }
      safeSendMessage({
        action: "bulkExportProgress",
        processed: message.processed,
        total: state.totalChats,
        currentBatch: nextBatchNumber,
        totalBatches: state.totalBatches,
        status: message.status,
        downloadedFiles: state.downloadedFiles,
      });
      break;
    }

    case "batchComplete": {
      // Update state with downloaded file
      await setBulkExportState({
        ...state,
        currentBatchNumber: message.batchNumber,
        downloadedFiles: [...state.downloadedFiles, message.zipFilename],
      });
      break;
    }

    case "requestDownload": {
      // Worker requests a download - handle it via chrome.downloads API
      // CRD-003: Service worker acts as browser API bridge
      const requestId = message.requestId || `download_${Date.now()}_${Math.random()}`;
      try {
        // Download file directly with chrome.downloads API
        const downloadId = await new Promise<number>((resolve, reject) => {
          chrome.downloads.download(
            {
              url: message.dataUrl,
              filename: message.filename,
              saveAs: false,
            },
            (id) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else if (id === undefined) {
                reject(new Error("Download returned undefined ID"));
              } else {
                resolve(id);
              }
            },
          );
        });
        log.info(`[BulkExport] Download successful, downloadId:`, downloadId);

        // Send success response back to worker via offscreen document
        chrome.runtime.sendMessage({
          type: "workerRequest",
          workerType: "bulkExport",
          operation: "downloadComplete",
          data: {
            type: "downloadComplete",
            requestId,
            success: true,
            downloadId,
          },
        });
      } catch (error) {
        log.error("[BulkExport] Failed to handle download request:", error);
        // Send error response back to worker via offscreen document
        chrome.runtime.sendMessage({
          type: "workerRequest",
          workerType: "bulkExport",
          operation: "downloadComplete",
          data: {
            type: "downloadComplete",
            requestId,
            success: false,
            error: error instanceof Error ? error.message : "Download failed",
          },
        });
      }
      break;
    }

    case "complete": {
      // Export complete
      log.info(`[BulkExport] Received complete message:`, {
        processed: message.processed,
        skipped: message.skipped,
      });
      const finalState = await getBulkExportState();
      if (finalState) {
        await setBulkExportState({
          ...finalState,
          status: "complete",
          processedChats: message.processed,
          skippedCount: message.skipped,
        });
        const exportState = await getExportJobState();
        log.info(`[BulkExport] Export state for download:`, {
          hasExportState: !!exportState,
          exportId: exportState?.exportId,
          zipPath: exportState?.zipPath,
        });
        if (exportState) {
          await setExportJobState({
            ...exportState,
            status: "complete",
            processedChats: message.processed,
            lastCheckpointAt: Date.now(),
          });
          log.info(`[BulkExport] Starting download of ZIP...`);
          fireAndForget(downloadExportZip(exportState), "Download export ZIP after completion");
        } else {
          log.error(`[BulkExport] No export state available for download!`);
        }
        await cleanupBulkExport("bulkExportComplete");
      } else {
        log.error(`[BulkExport] No bulk export state in complete handler!`);
      }
      break;
    }

    case "error": {
      // Worker encountered an error
      log.error("[BulkExport] Worker error:", message.error);
      await setBulkExportState({
        ...state,
        status: "error",
      });
      const exportState = await getExportJobState();
      if (exportState) {
        await setExportJobState({
          ...exportState,
          status: "error",
          error: message.error,
          lastCheckpointAt: Date.now(),
        });
      }
      await cleanupBulkExport("bulkExportFailed");
      safeSendMessage({
        action: "bulkExportFailed",
        error: message.error,
      });
      break;
    }

    case "paused": {
      await setBulkExportState({
        ...state,
        status: "paused",
      });
      const exportState = await getExportJobState();
      if (exportState) {
        await setExportJobState({
          ...exportState,
          status: "paused",
          lastCheckpointAt: Date.now(),
        });
      }
      safeSendMessage({
        action: "bulkExportPaused",
        status: `Paused at ${state.processedChats} of ${state.totalChats} chats`,
      });
      break;
    }

    case "cancelled": {
      const exportState = await getExportJobState();
      if (exportState) {
        await setExportJobState({
          ...exportState,
          status: "cancelled",
          lastCheckpointAt: Date.now(),
        });
      }
      await cleanupBulkExport("bulkExportCanceled");
      break;
    }
  }
}

async function downloadExportZip(exportState: {
  exportId: string;
  zipPath: string;
}): Promise<void> {
  log.info(`[BulkExport] downloadExportZip called:`, {
    exportId: exportState.exportId,
    zipPath: exportState.zipPath,
  });
  const waitForDownloadEstablished = (downloadId: number, timeoutMs: number): Promise<boolean> =>
    new Promise((resolve) => {
      let timeoutId: number | undefined;
      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        chrome.downloads.onChanged.removeListener(listener);
      };
      const listener = (delta: chrome.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        const state = delta.state?.current;
        const bytesReceived = delta.bytesReceived?.current ?? 0;
        if (state || bytesReceived > 0) {
          cleanup();
          resolve(true);
        }
      };
      chrome.downloads.onChanged.addListener(listener);
      timeoutId = self.setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
    });

  let blobUrl: string | null = null;
  let downloadId: number | null = null;
  let downloadEstablished = false;
  try {
    log.info(`[BulkExport] Creating blob URL from offscreen...`);
    blobUrl = await createBlobUrlFromOffscreen(exportState.zipPath);
    log.info(`[BulkExport] Got blob URL:`, { blobUrl: blobUrl.substring(0, 50) + "..." });
    const filename = `haevn_export_${exportState.exportId}.zip`;
    log.info(`[BulkExport] Starting download with filename:`, { filename });
    downloadId = await new Promise<number>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: blobUrl,
          filename,
          saveAs: false,
        },
        (id) => {
          if (chrome.runtime.lastError) {
            log.error(`[BulkExport] Download failed:`, chrome.runtime.lastError.message);
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (!id) {
            log.error(`[BulkExport] Download returned undefined ID`);
            reject(new Error("Download returned undefined ID"));
            return;
          }
          log.info(`[BulkExport] Download started with ID:`, { downloadId: id });
          resolve(id);
        },
      );
    });
    downloadEstablished = await waitForDownloadEstablished(downloadId, 10_000);
    if (!downloadEstablished) {
      log.warn(`[BulkExport] Download did not report progress before timeout.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    log.info(`[BulkExport] Download requested.`);
  } catch (error) {
    log.error(`[BulkExport] downloadExportZip error:`, error);
    throw error;
  } finally {
    if (blobUrl) {
      if (!downloadEstablished && downloadId !== null) {
        await waitForDownloadEstablished(downloadId, 10_000);
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      log.info(`[BulkExport] Revoking blob URL...`);
      try {
        await revokeBlobUrlFromOffscreen(blobUrl);
      } catch (revokeError) {
        log.warn(`[BulkExport] Failed to revoke blob URL:`, revokeError);
      }
    }
  }
}

/**
 * Starts a new bulk export operation.
 * Initializes state and starts the worker.
 */
export async function startBulkExport(chatIds: string[], options: ExportOptions): Promise<void> {
  // Try to acquire operation lock
  const lockAcquired = await acquireOperationLock("bulkExport");
  if (!lockAcquired) {
    const activeOp = await getActiveOperation();
    safeSendMessage({
      action: "bulkExportFailed",
      error: `Cannot start bulk export: ${activeOp} is currently in progress.`,
    });
    return;
  }

  // Wrap entire initialization in try-finally to ensure lock is always released on error
  try {
    if (chatIds.length === 0) {
      safeSendMessage({
        action: "bulkExportFailed",
        error: "No chats selected for export",
      });
      return;
    }
    // Calculate total batches (BATCH_SIZE is defined in worker)
    const BATCH_SIZE = 100;
    const totalBatches = Math.ceil(chatIds.length / BATCH_SIZE);
    log.info(
      `[BulkExport] Starting export: ${chatIds.length} chats split into ${totalBatches} batch(es)`,
    );
    const exportId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const exportTimestamp = new Date().toISOString();
    const haevnVersion = chrome.runtime.getManifest().version || "unknown";
    const exportVersion = "1";

    const manifestWriter = new ExportManifestWriter(exportId);
    await setExportJobState({
      exportId,
      status: "running",
      totalChats: chatIds.length,
      processedChats: 0,
      processedMedia: 0,
      bytesWritten: 0,
      startedAt: Date.now(),
      lastCheckpointAt: Date.now(),
      stagingRoot: buildExportStagingRoot(exportId),
      zipPath: buildExportZipPath(exportId),
      manifestPaths: manifestWriter.getPaths(),
    });

    // Initialize state
    const initialState: BulkExportState = {
      status: "running",
      totalChats: chatIds.length,
      processedChats: 0,
      remainingChatIds: chatIds,
      options,
      currentBatchNumber: 0,
      totalBatches,
      downloadedFiles: [],
      skippedCount: 0,
      globalAttachmentIndex: 0,
    };

    await setBulkExportState(initialState);

    // Start the worker with progress handler
    // Use fireAndForget so the function returns immediately but progress continues
    fireAndForget(
      sendWorkerRequest(
        "bulkExport",
        {
          type: "start",
          chatIds,
          options,
          exportId,
          meta: {
            haevnVersion,
            exportVersion,
            exportTimestamp,
          },
        },
        {
          onProgress: handleWorkerMessage,
          timeout: 600000, // 10 minutes for large exports
        },
      ),
      "Bulk export progress monitoring",
    );

    safeSendMessage({
      action: "bulkExportStarted",
      totalChats: chatIds.length,
      totalBatches,
    });
  } catch (error) {
    log.error("[BulkExport] Initialization failed:", error);
    await setBulkExportState(null);
    safeSendMessage({
      action: "bulkExportFailed",
      error: error instanceof Error ? error.message : "An unknown error occurred.",
    });
  } finally {
    // Always release lock if we hit an error during initialization
    // Note: On success, the lock is held and released in cleanupBulkExport()
    const state = await getBulkExportState();
    if (!state || state.status !== "running") {
      await releaseOperationLock("bulkExport");
    }
  }
}

/**
 * Legacy function - no longer needed as worker handles processing
 * Kept for backward compatibility with alarm listener
 */
export async function handleBulkExportTick(): Promise<void> {
  // Worker handles all processing now, this is just a no-op
  // Alarm-based processing is no longer used
  log.info("[BulkExport] handleBulkExportTick called (no-op in worker mode)");
}

/**
 * Pauses an ongoing bulk export.
 */
export async function pauseBulkExport(): Promise<void> {
  const state = await getBulkExportState();
  if (state && state.status === "running") {
    await sendWorkerRequest("bulkExport", { type: "pause" }, { expectResponse: false });
  }
}

/**
 * Resumes a paused bulk export.
 */
export async function resumeBulkExport(): Promise<void> {
  const state = await getBulkExportState();
  if (state && state.status === "paused") {
    await setBulkExportState({
      ...state,
      status: "running",
    });
    safeSendMessage({
      action: "bulkExportResumed",
      status: `Resumed at ${state.processedChats} of ${state.totalChats} chats`,
    });
    await sendWorkerRequest("bulkExport", { type: "resume" }, { expectResponse: false });
  }
}

/**
 * Cancels an ongoing bulk export.
 */
export async function cancelBulkExport(): Promise<void> {
  const state = await getBulkExportState();
  if (state && (state.status === "running" || state.status === "paused")) {
    try {
      await withTimeout(
        sendWorkerRequest("bulkExport", { type: "cancel" }, { expectResponse: false }),
        2000,
        "bulk export cancel",
      );
    } catch (error) {
      log.warn("[BulkExport] Cancel request timed out, forcing cleanup:", error);
      const exportState = await getExportJobState();
      if (exportState) {
        await setExportJobState({
          ...exportState,
          status: "cancelled",
          lastCheckpointAt: Date.now(),
        });
      }
      await cleanupBulkExport("bulkExportCanceled");
    }
  }
}

/**
 * Cleans up bulk export state and sends completion message.
 */
async function cleanupBulkExport(action: string): Promise<void> {
  // Release operation lock first
  await releaseOperationLock("bulkExport");

  const state = await getBulkExportState();
  if (!state) {
    return;
  }

  if (action === "bulkExportComplete") {
    const message = `Exported ${state.processedChats} chats in ${
      state.currentBatchNumber
    } batch(es)${state.skippedCount > 0 ? ` (${state.skippedCount} skipped)` : ""}.`;
    safeSendMessage({
      action: "bulkExportComplete",
      message,
    });
  } else if (action === "bulkExportCanceled") {
    safeSendMessage({
      action: "bulkExportCanceled",
      status: `Canceled after ${state.processedChats} of ${state.totalChats} chats.`,
    });
  } else if (action === "bulkExportFailed") {
    safeSendMessage({
      action: "bulkExportFailed",
      error: "Bulk export failed",
    });
  }

  // Clear state
  await setBulkExportState(null);
  await setExportJobState(null);

  // Clean up worker (optional - can keep it alive for future exports)
  // _exportWorker?.terminate();
  // _exportWorker = null;
  // _workerReady = false;
}
