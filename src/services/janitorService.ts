/**
 * JanitorService - Background cleanup for soft-deleted chats
 *
 * This service permanently deletes chats that have been soft-deleted
 * for longer than the grace period. It handles cleanup of:
 * - IndexedDB chat rows
 * - Thumbnails and mediaContent entries
 * - OPFS media files
 * - Search index entries
 *
 * The grace period allows for potential "undo" functionality in the future
 * and ensures we don't immediately commit to expensive file operations.
 */

import { log } from "../utils/logger";
import { ChatRepository } from "./chatRepository";

// Default grace period: 5 minutes
// Chats must be soft-deleted for at least this long before permanent cleanup
const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000;

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JanitorService {
  /**
   * Cleans up all soft-deleted chats that have passed the grace period.
   * This should be called periodically (e.g., on startup, via chrome.alarms, or on idle).
   *
   * @param gracePeriodMs Time in milliseconds that must pass after soft deletion before permanent cleanup
   * @returns Number of chats permanently deleted
   */
  export async function cleanupSoftDeletedChats(
    gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  ): Promise<number> {
    try {
      const chatIds = await ChatRepository.getSoftDeletedChatIds(gracePeriodMs);

      if (chatIds.length === 0) {
        log.debug("[Janitor] No soft-deleted chats ready for cleanup");
        return 0;
      }

      log.info(`[Janitor] Found ${chatIds.length} soft-deleted chats ready for cleanup`);

      await ChatRepository.hardDeleteChats(chatIds);

      log.info(`[Janitor] Successfully cleaned up ${chatIds.length} chats`);
      return chatIds.length;
    } catch (error) {
      log.error("[Janitor] Failed to cleanup soft-deleted chats", error);
      throw error;
    }
  }

  /**
   * Runs the Janitor cleanup and logs results.
   * This is a fire-and-forget wrapper for use in startup/alarm contexts.
   */
  export function runCleanup(): void {
    cleanupSoftDeletedChats()
      .then((count) => {
        if (count > 0) {
          log.info(`[Janitor] Cleanup complete: ${count} chats permanently deleted`);
        }
      })
      .catch((err) => {
        log.error("[Janitor] Cleanup failed", err);
      });
  }
}

export default JanitorService;
