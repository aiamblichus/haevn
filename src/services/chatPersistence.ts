/**
 * Shared chat persistence logic for service worker and web workers
 *
 * This module contains pure persistence functions that can run in both
 * the service worker and web workers. It does NOT include side effects like:
 * - Search index updates (handled by caller)
 * - Cache updates (handled by caller)
 * - Thumbnail generation (handled by caller)
 * - Event broadcasting (handled by caller)
 *
 * This separation allows CPU-intensive import operations to run entirely
 * in workers without blocking the service worker.
 */

import objectHash from "object-hash";
import type { Chat } from "../model/haevn_model";
import { log } from "../utils/logger";
import { getDB } from "./db";

// --- Checksum Generation ---

/**
 * Generates a SHA-256 checksum for a chat's content.
 * Stable hashing via Web Crypto when available; falls back to object-hash (sha1) in non-web contexts.
 */
export async function generateChatChecksum(chat: Chat): Promise<string> {
  const contentToHash = { title: chat.title, messages: chat.messages };

  // Prefer Web Crypto API (available in Chrome extension service worker and workers)
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

  // Fallback: object-hash (sha1) to avoid runtime errors in tests/non-browser envs
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

// --- Provider Timestamp Derivation ---

/**
 * Attempts to extract providerLastModifiedTimestamp from raw platform data.
 * Only sets if not already set by the transformer.
 *
 * @param haevnChat The HAEVN chat object (may be mutated)
 * @param rawPlatformData Raw data from the platform
 * @returns The derived timestamp (ms) or undefined
 */
export function deriveProviderTimestamp(
  haevnChat: Chat,
  rawPlatformData: unknown,
): number | undefined {
  // If transformer already set it, respect that
  if (haevnChat.providerLastModifiedTimestamp) {
    return haevnChat.providerLastModifiedTimestamp;
  }

  if (!rawPlatformData || typeof rawPlatformData !== "object") {
    return undefined;
  }

  const rawData = rawPlatformData as Record<string, unknown>;

  // Try updated_at (Claude, ChatGPT API format)
  if (rawData.updated_at && typeof rawData.updated_at === "string") {
    try {
      return new Date(rawData.updated_at).getTime();
    } catch {
      // Invalid date
    }
  }

  // Try update_time (ChatGPT API format)
  if (rawData.update_time && typeof rawData.update_time === "number") {
    return rawData.update_time * 1000; // Convert seconds to ms
  }

  // Try extractedAt (fallback for some providers like Gemini)
  if (rawData.extractedAt && typeof rawData.extractedAt === "string") {
    try {
      return new Date(rawData.extractedAt).getTime();
    } catch {
      // Invalid date
    }
  }

  return undefined;
}

// --- Core Database Persistence ---

/**
 * Saves a chat to IndexedDB (Dexie).
 * Pure database operation - no side effects.
 *
 * Caller is responsible for:
 * - Setting lastSyncedTimestamp
 * - Generating checksum
 * - Setting syncStatus
 * - Deriving providerLastModifiedTimestamp
 * - Updating search index
 * - Updating cache
 * - Broadcasting events
 * - Generating thumbnails
 *
 * @param chat The HAEVN chat object to save
 */
export async function saveChatToDb(chat: Chat): Promise<void> {
  if (!chat.id) {
    throw new Error("Chat missing id - cannot save");
  }
  const db = getDB();
  const chatId = chat.id;
  const messageRows = Object.values(chat.messages || {}).map((message) => ({
    ...message,
    chatId,
  }));
  const chatRow: Chat = {
    ...chat,
    messages: {},
  };

  await db.transaction("rw", db.chats, db.chatMessages, async () => {
    await db.chatMessages.where("chatId").equals(chatId).delete();
    if (messageRows.length > 0) {
      await db.chatMessages.bulkPut(messageRows);
    }
    await db.chats.put(chatRow);
  });
}

/**
 * Full save operation that sets all metadata and writes to DB.
 * This is the convenience function that workers should use.
 *
 * It does NOT trigger side effects like index updates or cache updates.
 * Caller must handle those separately via postProcess messages.
 *
 * @param haevnChat The chat to save
 * @param rawPlatformData Raw platform data for timestamp derivation
 * @returns Metadata needed for post-processing
 */
export async function saveChat(haevnChat: Chat, rawPlatformData: unknown): Promise<SaveChatResult> {
  const now = Date.now();

  // Check if chat already exists (for overwrite cleanup)
  if (haevnChat.id) {
    try {
      const existingChat = await getDB().chats.get(haevnChat.id);
      if (existingChat) {
        // Chat is being overwritten - clean up old data first

        // NOTE: We intentionally do NOT delete OPFS media here anymore.
        // The new media has already been downloaded by the transformer before saveChat is called.
        // Deleting here would destroy the freshly downloaded media.
        // Old media files will be orphaned and cleaned up by the janitor service.
        // See: JanitorService.cleanupOrphanedMediaFiles()

        // 2. Clean up thumbnail metadata from database
        try {
          const db = getDB();

          // Get all thumbnail IDs for this chat
          const thumbnails = await db.thumbnails.where("chatId").equals(haevnChat.id).toArray();

          const thumbnailIds = thumbnails
            .map((t) => t.id)
            .filter((id): id is number => id !== undefined);

          // Delete corresponding mediaContent entries
          if (thumbnailIds.length > 0) {
            await db.mediaContent.bulkDelete(thumbnailIds);
            log.info(
              `[ChatPersistence] Deleted ${thumbnailIds.length} mediaContent entries for chat ${haevnChat.id}`,
            );
          }

          // Delete thumbnail entries
          const deletedCount = await db.thumbnails.where("chatId").equals(haevnChat.id).delete();

          log.info(
            `[ChatPersistence] Deleted ${deletedCount} thumbnail entries for overwritten chat: ${haevnChat.id}`,
          );
        } catch (error) {
          log.error(
            `[ChatPersistence] Failed to clean up thumbnails for chat ${haevnChat.id}:`,
            error,
          );
          // Don't throw - continue with save even if cleanup fails
        }
      }
    } catch (error) {
      log.error(`[ChatPersistence] Error checking for existing chat ${haevnChat.id}:`, error);
      // Don't throw - continue with save
    }
  }

  // Set sync metadata
  haevnChat.lastSyncedTimestamp = now;
  haevnChat.checksum = await generateChatChecksum(haevnChat);
  haevnChat.syncStatus = "synced";
  haevnChat.lastSyncAttemptMessage = undefined; // Clear previous errors
  haevnChat.deleted = 0; // Mark as active (required for indexed queries)
  haevnChat.deletedAt = undefined; // Clear soft-delete timestamp if re-syncing

  // Derive provider timestamp if not already set
  const derivedTimestamp = deriveProviderTimestamp(haevnChat, rawPlatformData);
  if (derivedTimestamp && !haevnChat.providerLastModifiedTimestamp) {
    haevnChat.providerLastModifiedTimestamp = derivedTimestamp;
  }

  // Write to database
  await saveChatToDb(haevnChat);

  // Return metadata for post-processing
  if (!haevnChat.id) {
    throw new Error("Chat ID is required but was not set");
  }
  return {
    chatId: haevnChat.id,
    source: haevnChat.source,
    sourceId: haevnChat.sourceId,
    title: haevnChat.title,
    lastSyncedTimestamp: haevnChat.lastSyncedTimestamp,
    providerLastModifiedTimestamp: haevnChat.providerLastModifiedTimestamp,
    syncStatus: haevnChat.syncStatus,
    lastSyncAttemptMessage: haevnChat.lastSyncAttemptMessage,
  };
}

/**
 * Result of a save operation, containing metadata for post-processing
 */
export interface SaveChatResult {
  chatId: string;
  source?: string;
  sourceId?: string;
  title: string;
  lastSyncedTimestamp?: number;
  providerLastModifiedTimestamp?: number;
  syncStatus?: string;
  lastSyncAttemptMessage?: string;
}

// --- Helper Functions ---

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
 * Debug helper to count assistant parts in a chat
 * Used for validating Claude chat transformations
 */
export function countAssistantParts(chat: Chat): {
  textCount: number;
  thinkingCount: number;
} {
  let textCount = 0;
  let thinkingCount = 0;
  const messages = Object.values(chat.messages || {});
  for (const cm of messages) {
    const arr = cm?.message || [];
    for (const mm of arr) {
      if (mm.kind === "response") {
        for (const part of mm.parts) {
          const partAny = part as { part_kind?: string };
          const pk = partAny.part_kind;
          if (pk === "text") textCount++;
          if (pk === "thinking") thinkingCount++;
        }
      }
    }
  }
  return { textCount, thinkingCount };
}
