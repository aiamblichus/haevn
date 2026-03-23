// High-level chat operations with full side effects orchestration

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
  const providerCounts = new Map<string, number>();

  for (const chat of chats) {
    if (!chat) continue;
    const source = chat.source || "";
    const providerName = extractProviderName(source);
    if (!providerName) continue;

    providerCounts.set(providerName, (providerCounts.get(providerName) || 0) + 1);
  }

  // Soft delete chats (sets deletedAt field - instant operation)
  await SyncService.deleteChats(chatIds);

  // Invalidate sync status cache for deleted chats in bulk
  // Type guard that narrows to chats with required source and sourceId
  type ChatWithSync = NonNullable<(typeof chats)[number]> & { source: string; sourceId: string };
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

  // Update provider stats cache (decrement counts) in bulk
  const statsUpdate: Record<string, number> = {};
  for (const [providerName, count] of providerCounts.entries()) {
    statsUpdate[providerName] = -count;
  }

  if (Object.keys(statsUpdate).length > 0) {
    try {
      await CacheService.updateManyProviderStats(statsUpdate);
    } catch (err) {
      log.error(`[ChatService] Failed to update provider stats in bulk:`, err);
    }
  }
}

// Export as namespace
export const ChatService = {
  extractProviderName,
  deleteChatsWithCleanup,
};
