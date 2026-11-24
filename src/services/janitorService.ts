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

import {
  chatWritersGeneration,
  getActiveOperation,
  singleSyncsInFlight,
} from "../background/state";
import { SOFT_DELETE_GRACE_MS } from "../types/messaging";
import { log } from "../utils/logger";
import { ChatRepository } from "./chatRepository";
import { getDB } from "./db";
import { MEDIA_SWEEP_INTERVAL_MS, type MediaSweepReport, sweepMedia } from "./mediaSweep";

/** The `cache` row that remembers when the media sweep last ran. */
const MEDIA_SWEEP_LAST_RUN_KEY = "janitor:media-sweep:last-run";
/**
 * The `cache` row that remembers when the Janitor first looked at the sweep. A sweep that has never
 * run waits a day from then, so the dry run (haevnDebug.mediaSweep()) can be read before anything
 * is deleted.
 */
const MEDIA_SWEEP_FIRST_SEEN_KEY = "janitor:media-sweep:first-seen";

// Default grace period: 5 minutes
// Chats must be soft-deleted for at least this long before permanent cleanup
const DEFAULT_GRACE_PERIOD_MS = SOFT_DELETE_GRACE_MS;

/**
 * What is writing chats now, if anything: an operation that holds the lock, or a single-chat
 * sync (which takes none). Null when nothing is.
 */
async function whatIsWritingChats(): Promise<string | null> {
  const operation = await getActiveOperation();
  if (operation !== "idle") return operation;
  return singleSyncsInFlight() > 0 ? "a single-chat sync" : null;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JanitorService {
  /**
   * Cleans up all soft-deleted chats that have passed the grace period.
   * This should be called periodically (e.g., on startup, via chrome.alarms, or on idle).
   *
   * It does nothing while a bulk sync, an import (the ZIP import and the restore take the same
   * lock), a bulk export or a health check holds the operation lock, or while a single-chat sync
   * is running (it takes no lock; `singleSyncsInFlight` counts it). The check is made again
   * before each media folder is removed, and then it also fails if a restore, an import or a sync
   * began and ended since the run started (`chatWritersGeneration`).
   *
   * @param gracePeriodMs Time in milliseconds that must pass after soft deletion before permanent cleanup
   * @returns Number of chats permanently deleted
   */
  export async function cleanupSoftDeletedChats(
    gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS,
  ): Promise<number> {
    try {
      // A restore, an import, a bulk sync and a single-chat sync write a chat's media before its
      // row: the chat is still soft-deleted in that gap, and the Janitor would delete the new
      // media. The Janitor yields to them and waits for its next run (HVN-146).
      // The generation is read first. A writer that began before it is running now, and the check
      // below sees it; one that begins after it moves the generation, whether or not it has
      // finished by the time the folders go (see mayDeleteMedia).
      const generation = chatWritersGeneration();
      const running = await whatIsWritingChats();
      if (running) {
        log.info(`[Janitor] Not cleaning up while ${running} is running`);
        return 0;
      }

      const chatIds = await ChatRepository.getSoftDeletedChatIds(gracePeriodMs);

      if (chatIds.length === 0) {
        log.debug("[Janitor] No soft-deleted chats ready for cleanup");
        return 0;
      }

      log.info(`[Janitor] Found ${chatIds.length} soft-deleted chats ready for cleanup`);

      // Some may have been restored since the read: only the ones it deleted are counted.
      const deleted = await ChatRepository.hardDeleteChats(chatIds, {
        gracePeriodMs,
        // Asked before each media folder goes: an operation that is running, or that began since the
        // generation was read (and may be done already), keeps the folders.
        mayDeleteMedia: async () =>
          (await whatIsWritingChats()) === null && chatWritersGeneration() === generation,
      });

      log.info(`[Janitor] Successfully cleaned up ${deleted.length} chats`);
      return deleted.length;
    } catch (error) {
      log.error("[Janitor] Failed to cleanup soft-deleted chats", error);
      throw error;
    }
  }

  /**
   * Sweeps unreferenced media out of OPFS if a day has passed since the last sweep.
   * Cheap to call often: it returns null at once when the sweep is not due.
   *
   * The first sweep waits. The first time this is called it records when (the "first seen" row) and
   * deletes nothing; the sweep runs once that is a day old, and the daily gate applies after it.
   * haevnDebug.mediaSweep() is not held by the wait: a dry run works at any time, and
   * { dryRun: false } is an explicit act.
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
    if (typeof last?.value !== "number") {
      const firstSeen = await db.cache.get(MEDIA_SWEEP_FIRST_SEEN_KEY);
      if (typeof firstSeen?.value !== "number") {
        const now = Date.now();
        await db.cache.put({ id: MEDIA_SWEEP_FIRST_SEEN_KEY, value: now, lastUpdated: now });
        log.info(
          "[Janitor] The media sweep has never run: it waits a day, so haevnDebug.mediaSweep() can be read first",
        );
        return null;
      }
      if (Date.now() - firstSeen.value < MEDIA_SWEEP_INTERVAL_MS) {
        log.debug("[Janitor] The first media sweep is still waiting");
        return null;
      }
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
