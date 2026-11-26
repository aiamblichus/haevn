import { CacheService } from "../../services/cacheService";
import { SyncService } from "../../services/syncService";
import type { BulkSyncWorkerResponse } from "../../types/workerMessages";
import { log } from "../../utils/logger";
import { handleGenerateThumbnails } from "../handlers/galleryHandlers";
import { getBulkSyncState, setBulkSyncState } from "../state";
import { type BrowserApiRequest, handleBrowserApiRequest } from "../utils/browserApiBridge";
import { broadcastChatSynced } from "../utils/chatSyncUtils";
import { onWorkerReport } from "./orchestrator";
import { noteWorkerActivity, settleWorkerReport } from "./pendingHandoffs";

/**
 * Handle messages from the sync worker (forwarded from offscreen document)
 */
export async function handleWorkerMessage(message: BulkSyncWorkerResponse): Promise<void> {
  noteWorkerActivity();
  switch (message.type) {
    case "progress": {
      // Worker reports progress for a single chat. A report is for the run that asked: one from a
      // run that has ended, or from before a restart that the resume redid, must neither settle this
      // run's hand-off nor fail its chat (HVN-127). The check and the settle are one step (HVN-160).
      const settled = await settleWorkerReport({
        chatId: message.chatId,
        runId: message.runId,
        unstoredMedia: message.unstoredMedia,
      });
      if (!settled) {
        log.info(
          `[BulkSync] Ignoring a report for chat ${message.chatId} from another run (${message.runId})`,
        );
        return;
      }

      if (message.success) {
        // Chat successfully processed
        log.info(`[BulkSync] Worker processed chat ${message.chatId} successfully`);
      } else {
        // Chat failed
        log.warn(`[BulkSync] Worker failed to process chat ${message.chatId}:`, message.error);
        const state = await getBulkSyncState();
        if (state) {
          await setBulkSyncState({
            ...state,
            failedSyncs: [
              ...state.failedSyncs,
              { chatId: message.chatId, error: message.error || "Unknown error" },
            ],
          });
        }
      }

      // Note: Progress updates are sent by the fetch loop in handleBulkSyncTick()
      // to avoid conflicting progress values from stale currentIndex during batch processing

      // The chat is no longer the worker's: when it was the last, the sync can finish (HVN-123)
      await onWorkerReport();
      break;
    }

    case "postProcess": {
      // Worker requests post-processing (indexing, cache updates, broadcasting)
      const { summary } = message;
      try {
        // Update search index. The bulk sync worker saved the chat before it posted this, so the
        // search worker reads the saved row, not the message (HVN-76, HVN-121).
        await SyncService.addOrUpdateChatInIndex(message.chatId);

        // Update sync status cache
        if (summary.source && summary.sourceId) {
          await CacheService.setSyncStatus(summary.source, summary.sourceId, true, summary.id);
        }

        // Update provider stats cache if new chat
        if (message.isNewChat && message.platformName) {
          await CacheService.updateProviderStats(message.platformName, 1);
        }

        // Generate thumbnails (fire-and-forget)
        if (summary.id) {
          handleGenerateThumbnails(summary.id).catch((err) => {
            log.warn(`[BulkSync] Failed to generate thumbnails for ${summary.id}:`, err);
          });
        }

        // Broadcast chatSynced event
        broadcastChatSynced(summary);
      } catch (error) {
        log.error(`[BulkSync] Failed to post-process chat ${message.chatId}:`, error);
        // Don't fail the sync if post-processing fails
      }
      break;
    }

    case "error": {
      log.error("[BulkSync] Worker error:", message.error);
      break;
    }

    case "cancelled": {
      log.info("[BulkSync] Worker cancelled");
      break;
    }

    case "paused": {
      log.info("[BulkSync] Worker paused");
      break;
    }

    case "requestBrowserAPI": {
      // Handle browser API request from worker (CRD-003)
      // Worker lives in offscreen document, so we can't pass it directly.
      // Instead, we create a mock worker that forwards responses via chrome.runtime.sendMessage.
      const request: BrowserApiRequest = {
        type: "requestBrowserAPI",
        requestId: message.requestId ?? "",
        api: message.api as "downloads" | "storage" | "tabs" | "scripting" | "runtime",
        operation: message.operation,
        params: message.params,
      };

      // Create a mock worker to capture and forward the response
      const mockWorker = {
        postMessage: (msg: unknown) => {
          // Forward response to offscreen document -> bulkSync worker
          const msgObj = msg as Record<string, unknown>;
          if (typeof msg === "object" && msg !== null && msgObj.type === "browserApiResponse") {
            chrome.runtime.sendMessage({
              type: "workerRequest",
              workerType: "bulkSync",
              operation: "browserApiResponse",
              data: msg,
            });
          }
        },
      } as unknown as Worker;

      // handleBrowserApiRequest will call mockWorker.postMessage with the result/error
      await handleBrowserApiRequest(request, mockWorker);
      break;
    }
  }
}
