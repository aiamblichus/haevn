// Bulk Sync Worker - Offloads CPU-intensive transformation and saving
// to prevent blocking the service worker
//
// CRD-003: Service Worker as Browser API Bridge
// This worker cannot access Chrome APIs directly. When it needs to perform browser
// operations (e.g., search indexing, cache updates, broadcasting events), it sends
// requests to the service worker via postMessage. The service worker executes the
// API calls and sends responses back.

import type { HAEVN } from "../../model/haevn_model";
import { hasTextContent } from "../../providers/claude/transformer";
import * as ChatPersistence from "../../services/chatPersistence";
import { HaevnDatabase } from "../../services/db";
import type { AllProviderRawData } from "../../types/messaging";
import type { BulkSyncWorkerMessage } from "../../types/workerMessages";
import { log } from "../../utils/logger";
import { handleWorkerResponse } from "../../utils/media_utils";
import { transformRawDataToHaevn } from "../utils/platformTransform";

// Use the shared database class - worker gets its own instance
const db = new HaevnDatabase();

// Worker state
interface WorkerState {
  status: "running" | "paused" | "cancelled";
  processedCount: number;
  failedCount: number;
  skippedCount: number;
}

let workerState: WorkerState | null = null;

/**
 * Process a single sync task
 */
async function processSyncTask(task: {
  chatId: string;
  platformName: string | undefined;
  hostname: string;
  rawData: unknown;
  origin?: string;
  tabId?: number;
}): Promise<{ success: boolean; savedIds: string[]; error?: string }> {
  try {
    // Transform raw data to HAEVN format (CPU-intensive)
    const haevnChats = await transformRawDataToHaevn(
      task.rawData as AllProviderRawData,
      task.platformName,
      task.hostname,
      task.tabId,
    );

    // Apply Open WebUI origin if needed
    if (task.platformName === "openwebui" && task.origin) {
      for (const chat of haevnChats) {
        try {
          chat.params = {
            ...(chat.params || {}),
            openwebui_origin: task.origin,
          };
        } catch (_err) {
          // Ignore errors
        }
      }
    }

    const savedIds: string[] = [];

    // Save each chat (I/O-intensive)
    for (const haevnChat of haevnChats) {
      // Ensure chat has an ID
      if (!haevnChat.id) {
        log.error(
          "[BulkSyncWorker] Chat missing ID, skipping:",
          haevnChat.source,
          haevnChat.sourceId,
        );
        continue;
      }

      // For Claude chats, skip if there's no text content
      if (
        (task.platformName === "claude" || task.hostname.includes("claude.ai")) &&
        !hasTextContent(haevnChat as HAEVN.Chat)
      ) {
        log.info(`[BulkSyncWorker] Skipping Claude chat ${haevnChat.id} - no text content`);
        continue;
      }

      // Check if this is a new chat (before saving)
      const existingChat = await db.chats.get(haevnChat.id);
      const isNewChat = !existingChat;

      // Save the chat
      await ChatPersistence.saveChat(haevnChat, task.rawData);

      savedIds.push(haevnChat.id);

      // Request post-processing via service worker (indexing, cache updates, broadcasting)
      self.postMessage({
        type: "postProcess",
        chatId: haevnChat.id,
        chat: haevnChat,
        isNewChat,
        platformName: task.platformName,
      });
    }

    return { success: true, savedIds };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error(`[BulkSyncWorker] Failed to process sync task for ${task.chatId}:`, error);
    return { success: false, savedIds: [], error: errorMessage };
  }
}

// Message handler
self.onmessage = async (event: MessageEvent<BulkSyncWorkerMessage>) => {
  const msg = event.data;
  const requestId = msg.requestId;

  try {
    // Handle commands from service worker
    switch (msg.type) {
      case "sync": {
        // Initialize state if not already initialized
        if (!workerState) {
          workerState = {
            status: "running",
            processedCount: 0,
            failedCount: 0,
            skippedCount: 0,
          };
        }

        // Process the sync task
        const result = await processSyncTask(msg.data);

        if (result.success) {
          workerState.processedCount++;
          self.postMessage({
            type: "progress",
            chatId: msg.data.chatId,
            success: true,
            savedIds: result.savedIds,
            processed: workerState.processedCount,
            failed: workerState.failedCount,
            skipped: workerState.skippedCount,
            requestId,
          });
        } else {
          workerState.failedCount++;
          self.postMessage({
            type: "progress",
            chatId: msg.data.chatId,
            success: false,
            error: result.error,
            processed: workerState.processedCount,
            failed: workerState.failedCount,
            skipped: workerState.skippedCount,
            requestId,
          });
        }

        // Yield to event loop after each task
        await new Promise((resolve) => setTimeout(resolve, 0));
        break;
      }

      case "pause": {
        if (workerState) {
          workerState.status = "paused";
          self.postMessage({
            type: "paused",
            requestId,
          });
        }
        break;
      }

      case "resume": {
        if (workerState && workerState.status === "paused") {
          workerState.status = "running";
        }
        break;
      }

      case "cancel": {
        if (workerState) {
          workerState.status = "cancelled";
          self.postMessage({
            type: "cancelled",
            processed: workerState.processedCount,
            failed: workerState.failedCount,
            skipped: workerState.skippedCount,
            requestId,
          });
          workerState = null;
        }
        break;
      }

      case "reset": {
        workerState = null;
        break;
      }

      case "browserApiResponse": {
        // Handle browser API response (CRD-003)
        // This resolves the pending promise in processExternalAssets
        handleWorkerResponse(msg);
        break;
      }

      default: {
        log.error("[BulkSyncWorker] Unknown message type:", msg);
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${msg.type}`,
          requestId,
        });
      }
    }
  } catch (error) {
    log.error("[BulkSyncWorker] Error handling message:", error);
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      requestId,
    });
  }
};
