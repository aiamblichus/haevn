/**
 * ChatRepository - CRUD operations and query building for chat persistence
 *
 * Handles all database operations for chat management including:
 * - Saving and updating chats
 * - Retrieving chats with pagination, filtering, and sorting
 * - Existence checking (single and batch)
 * - Deletion with cascade cleanup
 *
 * This module delegates to ChatPersistence for core persistence logic
 * and uses SearchIndexManager for search index updates.
 */

import Dexie from "dexie";
import type { Chat, ChatMessage } from "../model/haevn_model";
import { log } from "../utils/logger";
import * as ChatPersistence from "./chatPersistence";
import { getDB } from "./db";
import { SearchIndexManager } from "./searchIndexManager";

/**
 * Helper function to extract metadata fields from chat objects.
 * Used to reduce memory footprint by only keeping necessary fields for UI display.
 */
function extractMetadataItem(chat: Chat): Partial<Chat> {
  return {
    id: chat.id,
    source: chat.source,
    title: chat.title,
    models: chat.models,
    lastSyncedTimestamp: chat.lastSyncedTimestamp,
    syncStatus: chat.syncStatus,
    providerLastModifiedTimestamp: chat.providerLastModifiedTimestamp,
    lastSyncAttemptMessage: chat.lastSyncAttemptMessage,
    params: chat.params, // Include params for Open WebUI origin check
  };
}

function extractMetadata(chats: Chat[]): Partial<Chat>[] {
  return chats.map(extractMetadataItem);
}

/**
 * Helper function to compare two chats for sorting.
 * Handles string comparison (case-insensitive) and null/undefined values.
 */
function sortComparator(a: Chat, b: Chat, sortBy: string, sortDirection: "asc" | "desc"): number {
  let valA: string | number = a[sortBy as keyof Chat] as string | number;
  let valB: string | number = b[sortBy as keyof Chat] as string | number;

  // Handle undefined/null values - convert to empty string for consistent comparison
  if (valA === undefined || valA === null) valA = "";
  if (valB === undefined || valB === null) valB = "";

  // Handle string comparison (case-insensitive)
  if (typeof valA === "string" && typeof valB === "string") {
    valA = valA.toLowerCase();
    valB = valB.toLowerCase();
  }

  // Convert to strings for consistent comparison when types might differ
  const strA = String(valA);
  const strB = String(valB);

  // For numeric fields, compare numerically
  if (typeof valA === "number" && typeof valB === "number") {
    if (valA < valB) return sortDirection === "asc" ? -1 : 1;
    if (valA > valB) return sortDirection === "asc" ? 1 : -1;
    return 0;
  }

  // String comparison
  if (strA < strB) return sortDirection === "asc" ? -1 : 1;
  if (strA > strB) return sortDirection === "asc" ? 1 : -1;
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace ChatRepository {
  function cloneWithoutMessages(chat: Chat): Chat {
    return {
      ...chat,
      messages: {},
    };
  }

  function toMessageDict(messages: ChatMessage[]): Record<string, ChatMessage> {
    return Object.fromEntries(messages.map((m) => [m.id, m]));
  }

  /**
   * Generates a SHA-256 checksum for a chat's content.
   * Stable hashing via Web Crypto when available; falls back to object-hash (sha1) in non-web contexts.
   */
  export async function generateChatChecksum(chat: Chat): Promise<string> {
    return ChatPersistence.generateChatChecksum(chat);
  }

  /**
   * Saves or updates a chat in the local IndexedDB archive.
   * This is the service worker version that includes all side effects.
   *
   * @param haevnChat The chat object in HAEVN schema.
   * @param rawPlatformData Raw data from the platform, used to extract provider-specific timestamps.
   */
  export async function saveChat(
    haevnChat: Chat,
    rawPlatformData: unknown,
    options?: { skipIndexing?: boolean },
  ): Promise<void> {
    try {
      // Note: Soft delete on Chat.deletedAt is the only deletion mechanism.
      // Resyncing a soft-deleted chat will restore it (deletedAt is cleared by the save).

      // Log incoming values for debugging
      const rawData =
        rawPlatformData && typeof rawPlatformData === "object"
          ? (rawPlatformData as Record<string, unknown>)
          : null;
      log.debug("saveChat called for chat", {
        chatId: haevnChat.id,
        source: haevnChat.source,
        incomingProviderLastModifiedTimestamp: haevnChat.providerLastModifiedTimestamp,
        incomingProviderLastModifiedTimestampDate: haevnChat.providerLastModifiedTimestamp
          ? new Date(haevnChat.providerLastModifiedTimestamp).toISOString()
          : null,
        rawDataHasUpdatedAt: !!rawData?.updated_at,
        rawDataUpdatedAt: rawData?.updated_at,
        rawDataHasExtractedAt: !!rawData?.extractedAt,
        rawDataExtractedAt: rawData?.extractedAt,
      });

      // Use shared persistence logic to save chat
      const result = await ChatPersistence.saveChat(haevnChat, rawPlatformData);

      // Log final timestamp
      log.debug("Final providerLastModifiedTimestamp after save", {
        chatId: result.chatId,
        providerLastModifiedTimestamp: result.providerLastModifiedTimestamp,
        providerLastModifiedTimestampDate: result.providerLastModifiedTimestamp
          ? new Date(result.providerLastModifiedTimestamp).toISOString()
          : null,
      });

      log.info(`Chat '${result.title}' (ID: ${result.chatId}) saved/updated`);

      // Debug: sanity-check thinking parts presence for providers that support it (e.g., Claude)
      try {
        if ((haevnChat.source || "").toLowerCase().includes("claude")) {
          const { textCount, thinkingCount } = ChatPersistence.countAssistantParts(haevnChat);
          log.debug("Claude chat parts summary", {
            chatId: haevnChat.id,
            textCount,
            thinkingCount,
          });
          if (thinkingCount === 0) {
            log.warn(
              "No ThinkingPart found in Claude chat. Upstream transformer may be merging thinking into text",
            );
          }
        }
      } catch {
        // ignore
      }

      // Update search index (side effect) - skip if requested (e.g., during bulk imports)
      if (!options?.skipIndexing) {
        try {
          await SearchIndexManager.addOrUpdateChatInIndex(haevnChat);
        } catch (e) {
          log.warn("Failed to update Lunr index for chat save", e);
        }
      }
    } catch (error) {
      log.error(`Failed to save chat '${haevnChat.id}'`, error);
      throw new Error(
        `Failed to save chat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieves metadata for synced chats for UI display.
   * Supports pagination, filtering, and sorting for better performance with large datasets.
   *
   * Performance: Uses compound indexes (v13+) for O(limit) pagination when filtering by provider.
   * Falls back to in-memory sorting only for non-indexed fields.
   *
   * @param offset - Number of records to skip (for pagination), defaults to 0
   * @param limit - Maximum number of records to return (for pagination), defaults to 50
   * @param filterProvider - Provider name to filter by ('all' for no filter), defaults to 'all'
   * @param sortBy - Field to sort by ('lastSyncedTimestamp', 'providerLastModifiedTimestamp', 'title'), defaults to 'lastSyncedTimestamp'
   * @param sortDirection - Sort direction ('asc' or 'desc'), defaults to 'desc'
   * @returns Object with metadata array and total count
   */
  export async function getChatsMetadata(
    offset: number = 0,
    limit: number = 50,
    filterProvider: string = "all",
    sortBy: string = "lastSyncedTimestamp",
    sortDirection: "asc" | "desc" = "desc",
  ): Promise<{ metadata: Partial<Chat>[]; total: number }> {
    try {
      const db = getDB();
      let query: Dexie.Collection<Chat, string>;

      // Check if sortBy is an indexed field we can use in compound indexes
      const isSortFieldIndexed =
        sortBy === "lastSyncedTimestamp" ||
        sortBy === "providerLastModifiedTimestamp" ||
        sortBy === "title";

      if (filterProvider !== "all" && isSortFieldIndexed) {
        // OPTIMIZED PATH: Provider filter + indexed sort field
        // Uses [deleted+source+sortBy] compound index for O(1) lookup
        const compoundIndexName = `[deleted+source+${sortBy}]`;
        query = db.chats
          .where(compoundIndexName)
          .between(
            [0, filterProvider, Dexie.minKey],
            [0, filterProvider, Dexie.maxKey],
            true,
            true,
          );

        if (sortDirection === "desc") {
          query = query.reverse();
        }
      } else if (filterProvider === "all" && isSortFieldIndexed) {
        // OPTIMIZED PATH: All providers + indexed sort field
        // Uses [deleted+sortBy] compound index for O(1) lookup
        const compoundIndexName = `[deleted+${sortBy}]`;
        query = db.chats
          .where(compoundIndexName)
          .between([0, Dexie.minKey], [0, Dexie.maxKey], true, true);

        if (sortDirection === "desc") {
          query = query.reverse();
        }
      } else if (filterProvider !== "all") {
        // FALLBACK: Provider filter + non-indexed sort field
        // Filter by deleted=0 first, then by source, then sort in memory
        query = db.chats
          .where("deleted")
          .equals(0)
          .filter((c) => c.source === filterProvider);
      } else {
        // FALLBACK: All providers + non-indexed sort field
        // Filter by deleted=0, then sort in memory
        query = db.chats.where("deleted").equals(0);
      }

      // 1. Get accurate total count (now efficient via index)
      const total = await query.count();

      // 2. Handle in-memory sorting for non-indexed fields
      const isIndexedSort = isSortFieldIndexed;

      if (!isIndexedSort) {
        // For non-indexed sorts we must scan every matching chat. Loading them all
        // via toArray() can exhaust the service worker's memory (2 000+ chats with
        // large message dictionaries easily exceeds 100 MB). Instead we stream
        // through them one at a time with each(), keeping only the lightweight
        // metadata + the sort key in memory at any point.
        //
        // Special case: "messageCount" is not stored as a field on Chat; we derive
        // it by counting the keys of the messages dictionary.
        type LeanChat = Partial<Chat> & { messageCount?: number };
        const lean: LeanChat[] = [];

        await query.each((chat) => {
          const item: LeanChat = extractMetadataItem(chat);
          if (sortBy === "messageCount") {
            item.messageCount = 0;
          } else {
            (item as Record<string, unknown>)[sortBy] =
              (chat as unknown as Record<string, unknown>)[sortBy];
          }
          lean.push(item);
        });

        if (sortBy === "messageCount") {
          const counts = await Promise.all(
            lean.map(async (item) => ({
              id: item.id,
              count: item.id ? await getChatMessageCount(item.id) : 0,
            })),
          );
          const countMap = new Map(counts.map((c) => [c.id, c.count]));
          for (const item of lean) {
            item.messageCount = countMap.get(item.id);
          }
        }

        lean.sort((a, b) =>
          sortComparator(a as unknown as Chat, b as unknown as Chat, sortBy, sortDirection),
        );

        return { metadata: lean.slice(offset, offset + limit), total: lean.length };
      }

      // 3. Apply pagination to the filtered query (for indexed sorts)
      if (offset > 0) query = query.offset(offset);
      if (limit > 0) query = query.limit(limit);

      const chats = await query.toArray();
      return { metadata: extractMetadata(chats), total };
    } catch (error) {
      log.error("Failed to get chat metadata", error);
      throw new Error(
        `Failed to retrieve chat list: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieves a full HAEVN.Chat object by its ID.
   * @param chatId The ID of the chat to retrieve.
   */
  export async function getChat(chatId: string): Promise<Chat | undefined> {
    try {
      const chat = await getDB().chats.get(chatId);
      // Return undefined for soft-deleted chats
      if (chat?.deletedAt) return undefined;
      return chat ? cloneWithoutMessages(chat) : undefined;
    } catch (error) {
      log.error(`Failed to get chat '${chatId}'`, error);
      throw new Error(
        `Failed to retrieve chat content: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Retrieves a chat by its source and sourceId using the compound index.
   * This is much more efficient than scanning all chats.
   * @param source The provider name (e.g., "claude", "chatgpt")
   * @param sourceId The provider's chat ID (e.g., Claude UUID, ChatGPT conversation ID)
   * @returns The chat if found, undefined otherwise
   */
  export async function getChatBySourceId(
    source: string,
    sourceId: string,
  ): Promise<Chat | undefined> {
    try {
      // Use compound index for efficient lookup
      const result = await getDB()
        .chats.where("[source+sourceId]")
        .equals([source, sourceId])
        .first();
      // Filter out soft-deleted chats so they are treated as "missing" (e.g. for re-syncing)
      if (result?.deletedAt) return undefined;
      return result ? cloneWithoutMessages(result) : undefined;
    } catch (error) {
      log.error(`Failed to get chat by sourceId '${sourceId}' from '${source}'`, error);
      throw new Error(
        `Failed to retrieve chat by sourceId: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  export async function getChatMessages(chatId: string): Promise<Record<string, ChatMessage>> {
    const db = getDB();
    const rows = await db.chatMessages.where("chatId").equals(chatId).toArray();
    if (rows.length > 0) {
      return toMessageDict(rows);
    }

    // Legacy fallback while lazy migration is still in-progress.
    const chat = await db.chats.get(chatId);
    return (chat?.messages || {}) as Record<string, ChatMessage>;
  }

  export async function getChatWithMessages(chatId: string): Promise<Chat | undefined> {
    const chat = await getChat(chatId);
    if (!chat) return undefined;
    const messages = await getChatMessages(chatId);
    return { ...chat, messages };
  }

  export async function getBranchMessages(
    chatId: string,
    leafMessageId: string,
  ): Promise<ChatMessage[]> {
    const db = getDB();
    const messageDict = await getChatMessages(chatId);
    if (!messageDict[leafMessageId]) {
      return [];
    }

    const branchIds: string[] = [];
    let currentId: string | undefined = leafMessageId;
    let guard = 0;

    while (currentId && guard < 10_000) {
      branchIds.unshift(currentId);
      guard++;
      const msg =
        messageDict[currentId] ||
        (await db.chatMessages.where("[chatId+id]").equals([chatId, currentId]).first());
      currentId = msg?.parentId || undefined;
    }

    return branchIds.map((id) => messageDict[id]).filter((msg): msg is ChatMessage => !!msg);
  }

  export async function getPrimaryBranchMessages(chatId: string): Promise<ChatMessage[]> {
    const chat = await getChat(chatId);
    if (!chat?.currentId) return [];
    return getBranchMessages(chatId, chat.currentId);
  }

  export async function getChatMessagePage(
    chatId: string,
    offset: number,
    limit: number,
  ): Promise<{ messages: ChatMessage[]; total: number }> {
    const branch = await getPrimaryBranchMessages(chatId);
    const safeOffset = Math.max(0, offset);
    const safeLimit = Math.max(0, limit);
    const messages = safeLimit > 0 ? branch.slice(safeOffset, safeOffset + safeLimit) : branch;
    return { messages, total: branch.length };
  }

  export async function getChatMessageCount(chatId: string): Promise<number> {
    const db = getDB();
    const migratedCount = await db.chatMessages.where("chatId").equals(chatId).count();
    if (migratedCount > 0) {
      return migratedCount;
    }
    const chat = await db.chats.get(chatId);
    return Object.keys(chat?.messages || {}).length;
  }

  export async function saveChatMessages(
    chatId: string,
    messages: Record<string, ChatMessage>,
  ): Promise<void> {
    const db = getDB();
    const rows = Object.values(messages || {}).map((message) => ({
      ...message,
      chatId,
    }));
    await db.transaction("rw", db.chatMessages, async () => {
      await db.chatMessages.where("chatId").equals(chatId).delete();
      if (rows.length > 0) {
        await db.chatMessages.bulkPut(rows);
      }
    });
  }

  export async function deleteChatMessages(chatId: string): Promise<void> {
    await getDB().chatMessages.where("chatId").equals(chatId).delete();
  }

  /**
   * Checks if a chat exists by sourceId and source (provider name).
   * Uses compound index for efficient lookup.
   * @param sourceId The provider's chat ID (e.g., Claude UUID, ChatGPT conversation ID)
   * @param source The provider name (e.g., "claude", "chatgpt")
   * @returns true if a chat with matching sourceId and source exists
   */
  export async function existsChatBySourceId(sourceId: string, source: string): Promise<boolean> {
    try {
      // Use compound index for efficient lookup
      const matchingChat = await getChatBySourceId(source, sourceId);
      return !!matchingChat;
    } catch (error) {
      log.error(`Failed to check chat existence for sourceId '${sourceId}'`, error);
      // On error, assume it doesn't exist to avoid blocking sync
      return false;
    }
  }

  /**
   * Batch checks which chats already exist for a given provider.
   * Uses compound index lookups for efficient batch checking.
   * @param sourceIds Array of provider chat IDs to check
   * @param source The provider name (e.g., "claude", "chatgpt")
   * @returns Set of sourceIds that already exist
   */
  export async function batchCheckExistingChats(
    sourceIds: string[],
    source: string,
  ): Promise<Set<string>> {
    try {
      const result = new Set<string>();

      // Use compound index lookups for each sourceId
      // Dexie's where().anyOf() doesn't work with compound indexes,
      // so we need to check each one individually, but this is still
      // much faster than loading all chats
      const checkPromises = sourceIds.map(async (sourceId) => {
        const chat = await getChatBySourceId(source, sourceId);
        return chat ? sourceId : null;
      });

      const existingIds = await Promise.all(checkPromises);
      for (const id of existingIds) {
        if (id) {
          result.add(id);
        }
      }

      return result;
    } catch (error) {
      log.error("Failed to batch check chat existence", error);
      // On error, return empty set to avoid blocking sync
      return new Set<string>();
    }
  }

  /**
   * Soft-deletes one or more chats from the local archive.
   * Sets the `deletedAt` timestamp so the Janitor can clean them up later.
   * This is nearly instant for the user - no file I/O or index rebuilds.
   * @param chatIds An array of chat IDs to soft delete.
   */
  export async function deleteChats(chatIds: string[]): Promise<void> {
    if (chatIds.length === 0) return;
    try {
      const db = getDB();
      const now = Date.now();

      // Bulk update: set deletedAt and deleted flag on all matching chats
      await db.chats.where("id").anyOf(chatIds).modify({ deletedAt: now, deleted: 1 });
      log.info(`Soft-deleted ${chatIds.length} chats (marked with deletedAt=${now}, deleted=1)`);
    } catch (error) {
      log.error(`Failed to soft-delete chats ${chatIds.join(", ")}`, error);
      throw new Error(
        `Failed to soft-delete chats: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Hard-deletes one or more chats from the local archive.
   * Performs actual cleanup: removes DB rows, thumbnails, mediaContent, OPFS files, and search index entries.
   * This is called by the Janitor service after the grace period.
   * @param chatIds An array of chat IDs to permanently delete.
   */
  export async function hardDeleteChats(chatIds: string[]): Promise<void> {
    if (chatIds.length === 0) return;
    try {
      const db = getDB();

      // Clean up thumbnail and mediaContent entries before deleting chats
      try {
        // Find all thumbnails for these chats
        const thumbnails = await db.thumbnails.where("chatId").anyOf(chatIds).toArray();
        const thumbnailIds = thumbnails
          .map((t) => t.id)
          .filter((id): id is number => id !== undefined);

        if (thumbnailIds.length > 0) {
          // Batch delete media content and thumbnails
          await db.mediaContent.bulkDelete(thumbnailIds);
          await db.thumbnails.bulkDelete(thumbnailIds);
          log.info(
            `Deleted ${thumbnailIds.length} thumbnails and mediaContent entries for ${chatIds.length} chats`,
          );
        }
      } catch (e) {
        log.warn("Failed to clean up thumbnails for deletions", e);
        // Don't throw - continue with deletion
      }

      try {
        await db.chatMessages.where("chatId").anyOf(chatIds).delete();
      } catch (e) {
        log.warn("Failed to delete chatMessages for hard-deleted chats", e);
      }

      await db.chats.bulkDelete(chatIds);
      log.info(`Hard-deleted chats: ${chatIds.join(", ")}`);

      // Update search index in bulk
      try {
        await SearchIndexManager.removeChatsFromIndexBulk(chatIds);
      } catch (e) {
        log.warn("Failed to update Lunr index for deletions", e);
      }

      // Clean up OPFS media files for deleted chats
      try {
        const { getMediaStorageService } = await import("./mediaStorage");
        const mediaStorage = getMediaStorageService();

        // Run OPFS deletions in parallel
        await Promise.all(chatIds.map((chatId) => mediaStorage.deleteChatDir(chatId)));
        log.info(`Cleaned up OPFS media for ${chatIds.length} chats`);
      } catch (e) {
        log.warn("Failed to clean up OPFS media for deletions", e);
        // Don't throw - deletion failures shouldn't block chat deletion
      }
    } catch (error) {
      log.error(`Failed to hard-delete chats ${chatIds.join(", ")}`, error);
      throw new Error(
        `Failed to hard-delete chats: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Retrieves all chats that are marked as soft-deleted and older than the grace period.
   * Used by Janitor to find chats ready for permanent cleanup.
   * @param gracePeriodMs Time in milliseconds that must have passed since deletedAt
   * @returns Array of chat IDs ready for hard deletion
   */
  export async function getSoftDeletedChatIds(gracePeriodMs: number): Promise<string[]> {
    const threshold = Date.now() - gracePeriodMs;
    const chats = await getDB().chats.where("deletedAt").below(threshold).toArray();
    return chats.filter((c): c is Chat & { id: string } => !!c.id).map((c) => c.id);
  }

  /**
   * Placeholder for the change detection method. Details in Phase 3.
   * @param chatId Optional: if provided, checks only this specific chat.
   */
  export async function performCheckForChanges(chatId?: string): Promise<void> {
    // Implementation will be in Phase 3
    log.warn(`performCheckForChanges called for ${chatId || "all chats"}. (Not yet implemented)`);
    // For now, just mark all as 'synced' for initial testing of metadata display
    if (!chatId) {
      const allChats = await getDB().chats.toArray();
      await getDB().chats.bulkPut(allChats.map((c) => ({ ...c, syncStatus: "synced" })));
    } else {
      const chat = await getDB().chats.get(chatId);
      if (chat) {
        await getDB().chats.put({ ...chat, syncStatus: "synced" });
      }
    }
  }
}
