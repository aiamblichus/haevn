import { safeSendMessage } from "../background/utils/messageUtils";
import { ensureOffscreenDocument } from "../background/utils/offscreenUtils";
import type { StatsWorkerMessage } from "../types/workerMessages";
import { log } from "../utils/logger";
import { sendWorkerRequest } from "../utils/workerApi";
import { type CacheEntry, getDB } from "./db";

// Stats Worker Management
// Three-Tier Architecture: Service Worker → Offscreen Document → Web Worker
// Service workers cannot create Workers, so we route through the offscreen document

// Fallback: Direct database query (no worker)
async function _calculateProviderStatsDirect(providerName: string): Promise<number> {
  try {
    const db = getDB();
    // Use indexed source field for exact match (O(log n) instead of O(n))
    const providerLower = providerName.toLowerCase();
    const count = await db.chats.where("source").equals(providerLower).count();
    return count;
  } catch (err) {
    log.error(`[CacheService] Failed to calculate stats for ${providerName}:`, err);
    return 0;
  }
}

/**
 * Send message to stats worker via offscreen document
 * Falls back to direct database query if worker is unavailable
 */
async function _sendStatsWorkerMessage(message: {
  type: "getProviderStats";
  providerName: string;
}): Promise<number>;
async function _sendStatsWorkerMessage(message: {
  type: "getAllProviderStats";
  providerNames: string[];
}): Promise<Array<{ key: string; count: number }>>;
async function _sendStatsWorkerMessage(
  message:
    | { type: "getProviderStats"; providerName: string }
    | { type: "getAllProviderStats"; providerNames: string[] },
): Promise<number | Array<{ key: string; count: number }>> {
  // Create the full message (requestId will be added by sendWorkerRequest)
  const fullMessage: StatsWorkerMessage =
    message.type === "getProviderStats"
      ? { ...message, requestId: "" } // requestId will be generated and added by sendWorkerRequest
      : { ...message, requestId: "" };

  try {
    const response = await sendWorkerRequest("stats", fullMessage);

    // Extract count or stats array from worker response
    if (response.type === "providerStatsResult" && typeof response.count === "number") {
      return response.count;
    } else if (response.type === "allProviderStatsResult" && response.stats) {
      return response.stats;
    } else {
      throw new Error("Unexpected response type from stats worker");
    }
  } catch (error) {
    // Fallback to direct query on error (only for getProviderStats)
    if (message.type === "getProviderStats") {
      return _calculateProviderStatsDirect(message.providerName);
    } else {
      throw error;
    }
  }
}

// Ensure worker is ready (no-op in new architecture - offscreen handles initialization)
async function _ensureStatsWorkerReady(): Promise<void> {
  // Ensure offscreen document exists
  await ensureOffscreenDocument();
  // Worker initialization happens lazily in offscreen document
}

/**
 * Comprehensive caching service for frequently accessed, easily-stale data.
 * Handles provider counts, sync status, and other cached values.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace CacheService {
  const CACHE_STALE_MS = 5 * 60 * 1000; // 5 minutes for provider counts
  const SYNC_STATUS_STALE_MS = 1 * 60 * 1000; // 1 minute for sync status (more frequently updated)

  /**
   * Get a cache key for provider count.
   */
  function getProviderCountKey(providerName: string): string {
    return `provider-count:${providerName}`;
  }

  /**
   * Get a cache key for sync status.
   */
  function getSyncStatusKey(source: string, sourceId: string): string {
    return `sync-status:${source}:${sourceId}`;
  }

  /**
   * Check if a cache entry is expired.
   */
  function isExpired(entry: CacheEntry, maxAgeMs: number = CACHE_STALE_MS): boolean {
    // Check expiration timestamp
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      return true;
    }

    // Check age against max age
    const age = Date.now() - entry.lastUpdated;
    return age > maxAgeMs;
  }

  /**
   * Generic cache getter with expiration check.
   */
  async function getCacheEntry(
    key: string,
    maxAgeMs: number = CACHE_STALE_MS,
  ): Promise<CacheEntry | null> {
    try {
      const entry = await getDB().cache.get(key);
      if (!entry) return null;

      // Check expiration
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        return null;
      }

      // Check age
      const age = Date.now() - entry.lastUpdated;
      if (age > maxAgeMs) {
        return null;
      }

      return entry;
    } catch (err) {
      log.error(`[CacheService] Failed to get cache entry for ${key}:`, err);
      return null;
    }
  }

  /**
   * Generic cache setter.
   */
  async function setCacheEntry(key: string, value: unknown, expiresInMs?: number): Promise<void> {
    try {
      const expiresAt = expiresInMs ? Date.now() + expiresInMs : undefined;
      await getDB().cache.put({
        id: key,
        value,
        lastUpdated: Date.now(),
        expiresAt,
      });
    } catch (err) {
      log.error(`[CacheService] Failed to set cache entry for ${key}:`, err);
    }
  }

  // ============================================================================
  // Provider Stats Methods (backward compatible)
  // ============================================================================

  /**
   * Get cached provider stats, or recalculate if cache is missing/stale.
   * Returns count immediately from cache if available, otherwise triggers background recalculation.
   * Never blocks - returns 0 if cache is missing and recalculates in background.
   */
  export async function getProviderStats(providerName: string): Promise<number> {
    const key = getProviderCountKey(providerName);
    try {
      const cached = await getCacheEntry(key, CACHE_STALE_MS);
      if (cached && cached.value !== undefined && cached.value !== null) {
        // Cache is fresh, return immediately
        return cached.value as number;
      }
    } catch (err) {
      log.error(`[CacheService] Failed to get cached stats for ${key}:`, err);
    }

    // Cache missing or stale - return 0 immediately and recalculate in background (non-blocking)
    // This prevents blocking the UI while stats are calculated
    // Worker will be initialized lazily when recalculateProviderStats is called

    // Recalculate in background - don't await
    (async () => {
      try {
        await recalculateProviderStats(providerName);
      } catch (err) {
        log.error(`[CacheService] Background recalculation failed for ${key}:`, err);
      }
    })();

    return 0;
  }

  /**
   * Recalculate provider stats from the database using efficient count queries.
   * Uses a Web Worker if available, otherwise falls back to direct database queries.
   * Notifies UI when stats are updated via chrome.runtime.sendMessage.
   */
  export async function recalculateProviderStats(providerName: string): Promise<number> {
    const key = getProviderCountKey(providerName);
    try {
      // Try to use worker via offscreen document (has built-in fallback)
      await _ensureStatsWorkerReady();
      const count = await _sendStatsWorkerMessage({
        type: "getProviderStats",
        providerName,
      });

      // Update cache
      await setCacheEntry(key, count);

      // Notify UI that stats have been updated
      safeSendMessage({
        action: "providerStatsUpdated",
        providerName,
        count,
      });

      log.info(`[CacheService] Recalculated stats for ${key}: ${count} chats`);
      return count;
    } catch (err) {
      log.error(`[CacheService] Failed to recalculate stats for ${key}:`, err);
      // Fallback to direct query on error
      try {
        const count = await _calculateProviderStatsDirect(providerName);
        await setCacheEntry(key, count);

        // Broadcast fallback result (cross-tab sync - Spec 03.05)
        safeSendMessage({
          action: "providerStatsUpdated",
          providerName,
          count,
        });

        return count;
      } catch {
        return 0;
      }
    }
  }

  /**
   * Increment or decrement provider stats cache for multiple providers.
   * Efficiently batches multiple updates.
   * Broadcasts cache updates to all extension contexts (cross-tab sync).
   */
  export async function updateManyProviderStats(stats: Record<string, number>): Promise<void> {
    const entries = Object.entries(stats);
    if (entries.length === 0) return;

    const db = getDB();
    const providersToRecalculate: string[] = [];
    const updatedProviders: Array<{ provider: string; count: number }> = [];

    try {
      await db.transaction("rw", db.cache, async () => {
        for (const [providerName, delta] of entries) {
          const key = getProviderCountKey(providerName);
          const entry = await db.cache.get(key);
          if (entry && !isExpired(entry, CACHE_STALE_MS)) {
            const currentCount = entry.value as number;
            const newCount = Math.max(0, currentCount + delta);
            await db.cache.put({
              id: key,
              value: newCount,
              lastUpdated: Date.now(),
              expiresAt: entry.expiresAt,
            });
            log.debug(
              `[CacheService] Updated ${key}: ${currentCount} -> ${newCount} (delta: ${delta})`,
            );

            // Track successful updates for broadcast
            updatedProviders.push({ provider: providerName, count: newCount });
          } else {
            providersToRecalculate.push(providerName);
          }
        }
      });

      // Recalculate stale providers outside transaction (broadcasts happen inside recalculateProviderStats)
      for (const provider of providersToRecalculate) {
        await recalculateProviderStats(provider);
      }

      // Broadcast transaction-based updates AFTER recalculation (cross-tab sync - Spec 03.05)
      // This ensures tabs only see final values, avoiding temporal inconsistency
      for (const { provider, count } of updatedProviders) {
        safeSendMessage({
          action: "providerStatsUpdated",
          providerName: provider,
          count,
        });
      }
    } catch (err) {
      log.error(`[CacheService] Failed to update many stats:`, err);
    }
  }

  /**
   * Increment or decrement provider stats cache.
   * Used when chats are added or deleted to keep cache in sync.
   * Uses atomic transaction to prevent race conditions during concurrent updates.
   */
  export async function updateProviderStats(providerName: string, delta: number): Promise<void> {
    await updateManyProviderStats({ [providerName]: delta });
  }

  /**
   * Initialize provider stats for all known providers.
   * Uses the worker to calculate all stats in parallel if available, otherwise uses direct queries.
   * Called on extension startup or when cache is missing.
   */
  export async function initializeProviderStats(providerNames: string[]): Promise<void> {
    log.info("[CacheService] Initializing provider stats cache...");
    const startTime = Date.now();

    try {
      // Try to use worker via offscreen document
      await _ensureStatsWorkerReady();

      const stats = await _sendStatsWorkerMessage({
        type: "getAllProviderStats",
        providerNames,
      });

      if (Array.isArray(stats)) {
        const cachePromises = stats.map(({ key, count }) => {
          return setCacheEntry(getProviderCountKey(key), count);
        });
        await Promise.all(cachePromises);

        const duration = Date.now() - startTime;
        log.info(
          `[CacheService] Initialization complete in ${duration}ms (${stats.length} providers, worker mode)`,
        );
        return;
      }
    } catch (err) {
      log.warn("[CacheService] Worker initialization failed, using direct queries:", err);
    }

    // Fallback: Direct queries (no worker)
    log.info("[CacheService] Using direct DB queries for initialization");
    const stats = await Promise.all(
      providerNames.map(async (providerName) => {
        const count = await _calculateProviderStatsDirect(providerName);
        await setCacheEntry(getProviderCountKey(providerName), count);
        return { key: providerName, count };
      }),
    );

    const duration = Date.now() - startTime;
    log.info(
      `[CacheService] Initialization complete in ${duration}ms (${stats.length} providers, direct mode)`,
    );
  }

  /**
   * Get all cached provider stats.
   * Useful for debugging or bulk operations.
   */
  export async function getAllProviderStats(): Promise<
    Array<{ id: string; count: number; lastUpdated: number }>
  > {
    try {
      const entries = await getDB()
        .cache.filter((entry) => entry.id.startsWith("provider-count:"))
        .toArray();
      return entries.map((entry) => ({
        id: entry.id.replace("provider-count:", ""),
        count: entry.value as number,
        lastUpdated: entry.lastUpdated,
      }));
    } catch (err) {
      log.error("[CacheService] Failed to get all stats:", err);
      return [];
    }
  }

  /**
   * Clear all provider stats cache.
   * Useful for debugging or forcing full recalculation.
   */
  export async function clearProviderStats(): Promise<void> {
    try {
      const entries = await getDB()
        .cache.filter((entry) => entry.id.startsWith("provider-count:"))
        .toArray();
      const keys = entries.map((e) => e.id);
      await getDB().cache.bulkDelete(keys);
      log.info("[CacheService] Cleared all cached provider stats");
    } catch (err) {
      log.error("[CacheService] Failed to clear stats:", err);
    }
  }

  // ============================================================================
  // Sync Status Methods (new)
  // ============================================================================

  /**
   * Get cached sync status for a chat.
   * Returns { synced: boolean, chatId: string | null } immediately from cache if available.
   * Returns null if cache is missing or stale.
   */
  export async function getSyncStatus(
    source: string,
    sourceId: string,
  ): Promise<{ synced: boolean; chatId: string | null } | null> {
    const key = getSyncStatusKey(source, sourceId);
    const cached = await getCacheEntry(key, SYNC_STATUS_STALE_MS);
    if (cached) {
      return cached.value as { synced: boolean; chatId: string | null };
    }
    return null;
  }

  /**
   * Set sync status in cache.
   */
  export async function setSyncStatus(
    source: string,
    sourceId: string,
    synced: boolean,
    chatId: string | null,
  ): Promise<void> {
    const key = getSyncStatusKey(source, sourceId);
    await setCacheEntry(key, { synced, chatId }, SYNC_STATUS_STALE_MS);
  }

  /**
   * Invalidate sync status cache for multiple chats.
   * Useful when multiple chats are synced or deleted.
   */
  export async function invalidateSyncStatusesBulk(
    items: Array<{ source: string; sourceId: string }>,
  ): Promise<void> {
    if (items.length === 0) return;
    const keys = items.map((item) => getSyncStatusKey(item.source, item.sourceId));
    try {
      await getDB().cache.bulkDelete(keys);
      log.debug(`[CacheService] Invalidated ${keys.length} sync status entries`);
    } catch (err) {
      log.error(`[CacheService] Failed to invalidate multiple sync statuses:`, err);
    }
  }

  /**
   * Invalidate sync status cache for a specific chat.
   * Useful when a chat is synced or deleted.
   */
  export async function invalidateSyncStatus(source: string, sourceId: string): Promise<void> {
    await invalidateSyncStatusesBulk([{ source, sourceId }]);
  }

  /**
   * Clear all sync status cache entries.
   */
  export async function clearSyncStatusCache(): Promise<void> {
    try {
      const entries = await getDB()
        .cache.filter((entry) => entry.id.startsWith("sync-status:"))
        .toArray();
      const keys = entries.map((e) => e.id);
      await getDB().cache.bulkDelete(keys);
      log.info("[CacheService] Cleared all sync status cache");
    } catch (err) {
      log.error("[CacheService] Failed to clear sync status cache:", err);
    }
  }

  // ============================================================================
  // Generic Cache Methods
  // ============================================================================

  /**
   * Get a generic cached value.
   */
  export async function get<T = unknown>(key: string, maxAgeMs?: number): Promise<T | null> {
    const entry = await getCacheEntry(key, maxAgeMs || CACHE_STALE_MS);
    return entry ? (entry.value as T) : null;
  }

  /**
   * Set a generic cached value.
   */
  export async function set(key: string, value: unknown, expiresInMs?: number): Promise<void> {
    await setCacheEntry(key, value, expiresInMs);
  }

  /**
   * Delete a cached value.
   */
  export async function deleteEntry(key: string): Promise<void> {
    try {
      await getDB().cache.delete(key);
    } catch (err) {
      log.error(`[CacheService] Failed to delete cache entry ${key}:`, err);
    }
  }

  /**
   * Clear all cache entries.
   */
  export async function clear(): Promise<void> {
    try {
      await getDB().cache.clear();
      log.info("[CacheService] Cleared all cache entries");
    } catch (err) {
      log.error("[CacheService] Failed to clear cache:", err);
    }
  }
}
