/**
 * SearchIndexManager - Coordinates Lunr.js search index via web worker
 *
 * Manages the full-text search index for chat content. Uses the three-tier
 * architecture: Service Worker → Offscreen Document → Web Worker.
 *
 * This module encapsulates all search index operations including:
 * - Index initialization and loading
 * - Adding/updating/removing chats in the index
 * - Bulk indexing mode for imports and bulk sync
 */

import { ensureOffscreenDocument } from "../background/utils/offscreenUtils";
import type {
  Chat,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";
import type { SearchWorkerMessage, SearchWorkerResponse } from "../types/workerMessages";
import { log } from "../utils/logger";
import { sendWorkerRequest } from "../utils/workerApi";

// --- Worker Communication ---
// Three-Tier Architecture: Service Worker → Offscreen Document → Web Worker
// Service workers cannot create Workers, so we route through the offscreen document

/**
 * Send message to search worker via offscreen document.
 * The offscreen document creates and manages the worker, routing messages.
 */
async function _sendWorkerMessage(
  message: SearchWorkerMessage,
): Promise<SearchWorkerResponse | string[] | undefined> {
  const response = await sendWorkerRequest("search", message);

  // For search results, extract the results array
  if (response && response.type === "searchResult" && response.results) {
    return response.results;
  }

  // For other operations, return the full result
  // Fire-and-forget operations return undefined
  if (
    response &&
    (response.type === "initComplete" ||
      response.type === "addComplete" ||
      response.type === "removeComplete" ||
      response.type === "bulkComplete")
  ) {
    return response;
  }

  return undefined;
}

/**
 * Ensure worker is ready (no-op in new architecture - offscreen handles initialization).
 */
async function _ensureWorkerReady(): Promise<void> {
  // Ensure offscreen document exists
  await ensureOffscreenDocument();
  // Worker initialization happens lazily in offscreen document
}

/**
 * Helper function to prepare chat for indexing.
 * Extracts searchable content from the chat structure.
 */
function _prepareChatForIndexing(
  chat: Chat,
): { id: string; title: string; content: string } | null {
  if (!chat.id) return null;
  const combined: string[] = [];
  // Include optional system prompt and title for better recall
  if (chat.system) combined.push(chat.system);
  if (chat.title) combined.push(chat.title);

  const messages = Object.values(chat.messages || {});
  for (const cm of messages) {
    const arr = cm?.message || [];
    for (const mm of arr) {
      if (mm.kind === "request") {
        const req = mm;
        for (const part of req.parts) {
          const partAny = part as { part_kind?: string };
          if (partAny.part_kind === "user-prompt") {
            const up = part as UserPromptPart;
            if (typeof up.content === "string") {
              combined.push(up.content);
            } else if (Array.isArray(up.content)) {
              for (const c of up.content) {
                if (typeof c === "string") combined.push(c);
              }
            }
          } else if (partAny.part_kind === "system-prompt") {
            const sp = part as SystemPromptPart;
            if (typeof sp.content === "string") {
              combined.push(sp.content);
            }
          }
        }
      } else if (mm.kind === "response") {
        const res = mm;
        for (const part of res.parts) {
          const partAny = part as { part_kind?: string };
          const pk = partAny.part_kind;
          if (pk === "text") combined.push((part as TextPart).content);
          else if (pk === "thinking") combined.push((part as ThinkingPart).content);
        }
      }
    }
  }

  return { id: chat.id, title: chat.title, content: combined.join(" ").trim() };
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SearchIndexManager {
  /**
   * Initialize search index: load from IndexedDB or build from existing chats.
   */
  export async function init(): Promise<void> {
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "init" });
  }

  /**
   * Rebuild the entire search index from all chats in the database.
   */
  export async function rebuildIndex(): Promise<void> {
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "rebuild" });
  }

  /**
   * Add or update a chat document in the Lunr index.
   */
  export async function addOrUpdateChatInIndex(chat: Chat): Promise<void> {
    const doc = _prepareChatForIndexing(chat);
    if (!doc) return;
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "add", doc });
  }

  /**
   * Remove a chat document from the Lunr index.
   */
  export async function removeChatFromIndex(chatId: string): Promise<void> {
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "remove", chatId });
  }

  /**
   * Remove multiple chat documents from the Lunr index.
   */
  export async function removeChatsFromIndexBulk(chatIds: string[]): Promise<void> {
    if (chatIds.length === 0) return;
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "removeMany", chatIds });
  }
  export async function startBulkSyncIndexing(): Promise<void> {
    await _ensureWorkerReady();
    await _sendWorkerMessage({ type: "startBulk" });
  }

  /**
   * Finish bulk sync indexing: triggers async rebuild and disables bulk mode.
   * This is non-blocking - the rebuild happens in the background with progress events.
   * Should be called at the end of bulk sync (or on error) to ensure index is up to date.
   */
  export async function finishBulkSyncIndexing(): Promise<void> {
    await _ensureWorkerReady();
    // End bulk mode first
    await _sendWorkerMessage({ type: "endBulk" });
    // Trigger async rebuild (non-blocking)
    log.info("[SearchIndexManager] Starting async index rebuild");
    // Fire rebuild without waiting for completion
    _sendWorkerMessage({ type: "rebuild" }).catch((err) => {
      log.error("[SearchIndexManager] Async rebuild failed:", err);
    });
  }
}
