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
  deleteExportFromOffscreen,
  revokeBlobUrlFromOffscreen,
  sweepExportsFromOffscreen,
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
 *
 * `exportId` is the export whose start registered this listener. The state in storage is the
 * current export's, and a message that arrives late (the answer to a cancel after a forced
 * cleanup, say) must not act on an export that started since.
 */
async function handleWorkerMessage(
  message: BulkExportWorkerResponse,
  exportId: string,
): Promise<void> {
  log.info(`[BulkExport] handleWorkerMessage received:`, {
    type: message.type,
    hasRequestId: "requestId" in message,
  });
  const state = await getBulkExportState();
  if (!state) {
    log.warn("[BulkExport] Received worker message but no state exists");
    return;
  }
  const job = await getExportJobState();
  if (job && job.exportId !== exportId) {
    log.warn(
      `[BulkExport] Ignoring a ${message.type} message from export ${exportId}: export ${job.exportId} is current`,
    );
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

// Chrome reports bytes only on a DownloadItem (from chrome.downloads.search), never on a
// DownloadDelta, so a download's progress is read by polling its item.
const DOWNLOAD_POLL_MS = 500;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function searchDownloads(downloadId: number): Promise<chrome.downloads.DownloadItem[]> {
  return new Promise((resolve, reject) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(items);
    });
  });
}

/** Chrome has received bytes for the download. */
export function isDownloadEstablished(
  item: Pick<chrome.downloads.DownloadItem, "bytesReceived">,
): boolean {
  return item.bytesReceived > 0;
}

/** The download is complete or has failed. A missing record has nothing left to wait for. */
export function isDownloadSettled(
  item: Pick<chrome.downloads.DownloadItem, "state"> | undefined,
): boolean {
  return item === undefined || item.state !== "in_progress";
}

/**
 * Resolves true once the download is established, or false if no bytes arrive in timeoutMs.
 * A state change in onChanged counts at once; until then the item is polled for bytes.
 */
export function waitForDownloadEstablished(
  downloadId: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let finished = false;
    const finish = (established: boolean) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(listener);
      resolve(established);
    };
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId && delta.state) finish(true);
    };
    chrome.downloads.onChanged.addListener(listener);
    const poll = async () => {
      while (!finished) {
        try {
          const [item] = await searchDownloads(downloadId);
          if (item && isDownloadEstablished(item)) {
            finish(true);
            return;
          }
        } catch (error) {
          log.warn("[BulkExport] Download search failed, retrying:", error);
        }
        if (Date.now() >= deadline) {
          finish(false);
          return;
        }
        await pause(DOWNLOAD_POLL_MS);
      }
    };
    fireAndForget(poll(), "Poll download progress");
  });
}

/** Resolves once the download is complete or has failed; a failed search is retried. */
export async function waitForDownloadSettled(downloadId: number): Promise<void> {
  for (;;) {
    try {
      const [item] = await searchDownloads(downloadId);
      if (isDownloadSettled(item)) return;
    } catch (error) {
      log.warn("[BulkExport] Download search failed, retrying:", error);
    }
    await pause(DOWNLOAD_POLL_MS);
  }
}

/**
 * Deletes an export's directory in OPFS (staging tree and ZIP). A failure is logged and left to
 * the sweep: the export it belongs to is over, and nothing should wait on its files.
 */
async function removeExportFiles(exportId: string): Promise<void> {
  try {
    await deleteExportFromOffscreen(exportId);
  } catch (error) {
    log.warn(`[BulkExport] Failed to delete the files of export ${exportId}:`, error);
  }
}

/**
 * Deletes the export directories in OPFS that no write has touched for a day, the orphans of
 * an export that was interrupted (a restart, a crash) or whose deletion failed. The export a job
 * is running or has paused is left alone. Run at start and on the Janitor's alarm.
 */
export async function sweepOrphanedExports(): Promise<void> {
  const job = await getExportJobState();
  const running = job && (job.status === "running" || job.status === "paused");
  const swept = await sweepExportsFromOffscreen(running ? job.exportId : undefined);
  if (swept.length > 0) {
    log.info(`[BulkExport] Swept ${swept.length} stale export(s) from OPFS`);
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

  let blobUrl: string | null = null;
  let downloadId: number | null = null;
  try {
    log.info(`[BulkExport] Creating blob URL from offscreen...`);
    const zipBlobUrl = await createBlobUrlFromOffscreen(exportState.zipPath);
    blobUrl = zipBlobUrl;
    log.info(`[BulkExport] Got blob URL:`, { blobUrl: `${zipBlobUrl.substring(0, 50)}...` });
    const filename = `haevn_export_${exportState.exportId}.zip`;
    log.info(`[BulkExport] Starting download with filename:`, { filename });
    downloadId = await new Promise<number>((resolve, reject) => {
      chrome.downloads.download(
        {
          url: zipBlobUrl,
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
    const established = await waitForDownloadEstablished(downloadId, 10_000);
    if (!established) {
      log.warn(`[BulkExport] Download did not report progress before timeout.`);
    }
    log.info(`[BulkExport] Download requested.`);
  } catch (error) {
    log.error(`[BulkExport] downloadExportZip error:`, error);
    throw error;
  } finally {
    if (blobUrl) {
      // Revoking earlier would cut off a zip that Chrome is still reading.
      if (downloadId !== null) {
        await waitForDownloadSettled(downloadId);
      }
      log.info(`[BulkExport] Revoking blob URL...`);
      try {
        await revokeBlobUrlFromOffscreen(blobUrl);
      } catch (revokeError) {
        log.warn(`[BulkExport] Failed to revoke blob URL:`, revokeError);
      }
    }
    // The ZIP is the user's now (or the download failed and nothing will read it again), and
    // the staging tree was only ever its source: neither is kept (HVN-62).
    await removeExportFiles(exportState.exportId);
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
          onProgress: (message) => handleWorkerMessage(message, exportId),
          // No timeout: the listener of this start carries the job's end (complete, cancelled,
          // error), however long it runs and however long it is paused.
          timeout: 0,
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

// How long a cancel waits for the worker's answer before it cleans up itself.
const CANCEL_GRACE_MS = 2000;
const CANCEL_POLL_MS = 50;

/** Resolves true once the bulk export state is gone, or false if it is still there at timeoutMs. */
async function waitForBulkExportEnd(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await getBulkExportState())) return true;
    if (Date.now() >= deadline) return false;
    await pause(CANCEL_POLL_MS);
  }
}

/**
 * Cancels an ongoing bulk export.
 *
 * The cancel goes to the worker with no requestId of its own, so the worker answers `cancelled`
 * on the requestId of the start, and the listener of that start (handleWorkerMessage) cleans up.
 * If the answer does not come within graceMs (the worker is gone, or has no such job), the
 * lock and the state are released here, so a cancel never leaves them held until a restart.
 */
export async function cancelBulkExport(graceMs = CANCEL_GRACE_MS): Promise<void> {
  const state = await getBulkExportState();
  if (state && (state.status === "running" || state.status === "paused")) {
    try {
      await sendWorkerRequest("bulkExport", { type: "cancel" }, { expectResponse: false });
    } catch (error) {
      log.warn("[BulkExport] Cancel request failed:", error);
    }
    if (await waitForBulkExportEnd(graceMs)) {
      return;
    }
    log.warn("[BulkExport] The worker did not answer the cancel, forcing cleanup");
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
  const job = await getExportJobState();
  await setBulkExportState(null);
  await setExportJobState(null);

  // A completed export is deleted once its download settles (downloadExportZip), not here: the
  // download still reads the ZIP. A failed or cancelled one has nothing left to wait for. A job
  // that is still writing (a forced cancel) may recreate files; the sweep takes them.
  if (job && action !== "bulkExportComplete") {
    await removeExportFiles(job.exportId);
  }

  // Clean up worker (optional - can keep it alive for future exports)
  // _exportWorker?.terminate();
  // _exportWorker = null;
  // _workerReady = false;
}
