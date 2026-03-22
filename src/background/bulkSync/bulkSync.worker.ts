// Bulk Sync Worker - Offloads CPU-intensive transformation and saving
// to prevent blocking the service worker
//
// CRD-003: Service Worker as Browser API Bridge
// This worker cannot access Chrome APIs directly. When it needs to perform browser
// operations (e.g., search indexing, cache updates, broadcasting events), it sends
// requests to the service worker via postMessage. The service worker executes the
// API calls and sends responses back.

import objectHash from "object-hash";
import type { Chat, HAEVN } from "../../model/haevn_model";
import { hasTextContent } from "../../providers/claude/transformer";
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

// Helper functions (replicated from SyncService)
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, "0");
    hex.push(h);
  }
  return hex.join("");
}

function stableStringify(value: unknown): string {
  return stringifySorted(value);
}

function stringifySorted(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map((v) => stringifySorted(v)).join(",")}]`;
  }
  const objRecord = obj as Record<string, unknown>;
  const keys = Object.keys(objRecord).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${stringifySorted(objRecord[k])}`);
  return `{${entries.join(",")}}`;
}

/**
 * Generates a SHA-256 checksum for a chat's content.
 * Stable hashing via Web Crypto when available; falls back to object-hash (sha1).
 */
async function generateChatChecksum(chat: Chat): Promise<string> {
  const contentToHash = { title: chat.title, messages: chat.messages };

  // Prefer Web Crypto API (available in Web Workers)
  try {
    if (globalThis.crypto && "subtle" in globalThis.crypto) {
      const stable = stableStringify(contentToHash);
      const data = new TextEncoder().encode(stable);
      const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
      return bufferToHex(digest);
    }
  } catch {
    // ignore and fall back
  }

  // Fallback: object-hash (sha1)
  try {
    return objectHash(contentToHash, { algorithm: "sha1" });
  } catch {
    // Last resort: JSON string hash via a trivial passthrough
    const result = objectHash(contentToHash, {
      algorithm: "passthrough",
    } as Parameters<typeof objectHash>[1]);
    return typeof result === "string" ? result : String(result);
  }
}

/**
 * Saves a chat to IndexedDB (replicated from SyncService.saveChat)
 */
async function saveChatToDB(haevnChat: Chat, rawPlatformData: unknown): Promise<void> {
  const now = Date.now();
  haevnChat.lastSyncedTimestamp = now;
  haevnChat.checksum = await generateChatChecksum(haevnChat);
  haevnChat.syncStatus = "synced";
  haevnChat.lastSyncAttemptMessage = undefined; // Clear previous errors
  haevnChat.deleted = 0; // Mark as active (required for indexed queries)
  haevnChat.deletedAt = undefined; // Clear soft-delete timestamp if re-syncing

  // Attempt to extract providerLastModifiedTimestamp from raw data
  if (
    !haevnChat.providerLastModifiedTimestamp &&
    rawPlatformData &&
    typeof rawPlatformData === "object"
  ) {
    const rawData = rawPlatformData as Record<string, unknown>;
    if (rawData.updated_at && typeof rawData.updated_at === "string") {
      haevnChat.providerLastModifiedTimestamp = new Date(rawData.updated_at).getTime();
    } else if (rawData.extractedAt && typeof rawData.extractedAt === "string") {
      haevnChat.providerLastModifiedTimestamp = new Date(rawData.extractedAt).getTime();
    }
  }

  await db.chats.put(haevnChat); // Dexie's put() handles insert or update
}

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
      await saveChatToDB(haevnChat, task.rawData);

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
