// High-level chat operations with full side effects orchestration

import type { Chat } from "../model/haevn_model";
import { SOFT_DELETE_GRACE_MS } from "../types/messaging";
import { log } from "../utils/logger";
import { CacheService } from "./cacheService";
import { getDB } from "./db";
import { SyncService } from "./syncService";

/**
 * Extract provider name from source string.
 * Shared utility used by multiple services (chat delete, import, etc.)
 */
function extractProviderName(source: string): string | null {
  const sourceLower = source.toLowerCase();
  const providers = [
    "gemini",
    "claude",
    "claudecode",
    "codex",
    "pi",
    "poe",
    "chatgpt",
    "openwebui",
    "qwen",
    "aistudio",
    "deepseek",
    "grok",
  ];
  for (const provider of providers) {
    if (sourceLower.includes(provider)) {
      return provider;
    }
  }
  return null;
}

/**
 * Keeps the sync status and provider count caches in step with a delete (sign -1) or a
 * restore (sign +1) of these chats.
 */
async function updateCachesForChats(chats: Array<Chat | undefined>, sign: 1 | -1): Promise<void> {
  const providerCounts = new Map<string, number>();

  for (const chat of chats) {
    if (!chat) continue;
    const source = chat.source || "";
    const providerName = extractProviderName(source);
    if (!providerName) continue;

    providerCounts.set(providerName, (providerCounts.get(providerName) || 0) + 1);
  }

  // Invalidate sync status cache for these chats in bulk
  // Type guard that narrows to chats with required source and sourceId
  type ChatWithSync = Chat & { source: string; sourceId: string };
  const cacheItems = chats
    .filter(
      (c): c is ChatWithSync =>
        !!c && typeof c.source === "string" && typeof c.sourceId === "string",
    )
    .map((c) => ({ source: c.source, sourceId: c.sourceId }));

  if (cacheItems.length > 0) {
    try {
      await CacheService.invalidateSyncStatusesBulk(cacheItems);
    } catch (err) {
      log.error(`[ChatService] Failed to invalidate sync status cache in bulk:`, err);
    }
  }

  // Update provider stats cache (decrement on delete, increment on restore) in bulk
  const statsUpdate: Record<string, number> = {};
  for (const [providerName, count] of providerCounts.entries()) {
    statsUpdate[providerName] = sign * count;
  }

  if (Object.keys(statsUpdate).length > 0) {
    try {
      await CacheService.updateManyProviderStats(statsUpdate);
    } catch (err) {
      log.error(`[ChatService] Failed to update provider stats in bulk:`, err);
    }
  }
}

/**
 * Delete chats with full cleanup orchestration:
 * - Soft delete (sets deletedAt field) via SyncService.deleteChats
 * - Invalidate sync status cache
 * - Update provider stats (decrement counts)
 *
 * Note: The actual cleanup (hard delete) is handled by JanitorService after a grace period.
 */
async function deleteChatsWithCleanup(chatIds: string[]): Promise<void> {
  if (chatIds.length === 0) {
    return;
  }

  // Get chats before deletion to determine provider stats updates
  const chats = await getDB().chats.bulkGet(chatIds);

  // Soft delete chats (sets deletedAt field - instant operation)
  await SyncService.deleteChats(chatIds);

  await updateCachesForChats(chats, -1);
}

/**
 * Undo a delete with the same cleanup, in reverse: clear the soft delete and re-index the chats
 * (SyncService.restoreChats), then restore the cache entries and provider counts.
 *
 * Only a chat still inside the grace period comes back; the others are left deleted, so the
 * result lists just the chats restored.
 */
async function restoreChatsWithCleanup(chatIds: string[]): Promise<string[]> {
  if (chatIds.length === 0) {
    return [];
  }

  const restoredIds = await SyncService.restoreChats(chatIds, SOFT_DELETE_GRACE_MS);
  if (restoredIds.length > 0) {
    const chats = await getDB().chats.bulkGet(restoredIds);
    await updateCachesForChats(chats, 1);
  }
  return restoredIds;
}

// Export as namespace
export const ChatService = {
  extractProviderName,
  deleteChatsWithCleanup,
  restoreChatsWithCleanup,
};
