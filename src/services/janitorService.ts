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
 * It also sweeps OPFS media that no chat refers to any more (see mediaSweep.ts), once a day.
 *
 * The grace period is the undo window (the archive's undo toast and ChatRepository.restoreChats)
 * and ensures we don't immediately commit to expensive file operations.
 */

import { SOFT_DELETE_GRACE_MS } from "../types/messaging";
import { log } from "../utils/logger";
import { ChatRepository } from "./chatRepository";
import { getDB } from "./db";
import { MEDIA_SWEEP_INTERVAL_MS, type MediaSweepReport, sweepMedia } from "./mediaSweep";

/** The `cache` row that remembers when the media sweep last ran. */
const MEDIA_SWEEP_LAST_RUN_KEY = "janitor:media-sweep:last-run";

// Default grace period: 5 minutes
// Chats must be soft-deleted for at least this long before permanent cleanup
const DEFAULT_GRACE_PERIOD_MS = SOFT_DELETE_GRACE_MS;

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
   * Sweeps unreferenced media out of OPFS if a day has passed since the last sweep.
   * Cheap to call often: it returns null at once when the sweep is not due.
   *
   * The time is recorded when the sweep finishes or fails, not when it is skipped for another
   * sweep already running. A sweep that is cut short (the worker is stopped) leaves no record and
   * runs again at the next call; what it deleted stays deleted.
   *
   * @returns The sweep's report, or null if it was not due
   */
  export async function sweepMediaIfDue(): Promise<MediaSweepReport | null> {
    const db = getDB();
    const last = await db.cache.get(MEDIA_SWEEP_LAST_RUN_KEY);
    if (typeof last?.value === "number" && Date.now() - last.value < MEDIA_SWEEP_INTERVAL_MS) {
      log.debug("[Janitor] Media sweep not due yet");
      return null;
    }

    let report: MediaSweepReport | null = null;
    try {
      report = await sweepMedia();
      return report;
    } catch (error) {
      log.error("[Janitor] Media sweep failed", error);
      throw error;
    } finally {
      if (report?.ran !== false) {
        const now = Date.now();
        await db.cache.put({ id: MEDIA_SWEEP_LAST_RUN_KEY, value: now, lastUpdated: now });
      }
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
