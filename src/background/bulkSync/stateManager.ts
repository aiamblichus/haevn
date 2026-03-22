/**
 * Bulk Sync State Manager
 *
 * Manages persisted state for bulk sync operations, enabling resume functionality
 * after service worker restarts (Spec 03.02).
 */

import { log } from "../../utils/logger";
import { getBulkSyncState, setBulkSyncState } from "../state";
import type { BulkSyncState } from "./types";

const STALE_STATE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export class BulkSyncStateManager {
  /**
   * Check if there is an incomplete sync that can be resumed.
   * Returns the state if resumable, null otherwise.
   * Auto-clears stale state (>24 hours old).
   */
  async checkForIncompleteSync(): Promise<BulkSyncState | null> {
    const state = await getBulkSyncState();
    if (!state) return null;

    // Only consider in_progress or paused states as resumable
    if (state.status !== "running" && state.status !== "paused") {
      return null;
    }

    // Check if state is fresh (< 24 hours old)
    const age = Date.now() - state.lastProgressAt;
    if (age >= STALE_STATE_THRESHOLD_MS) {
      log.info("[BulkSyncStateManager] Clearing stale state", {
        provider: state.provider,
        ageHours: Math.floor(age / (60 * 60 * 1000)),
      });
      await this.clearState();
      return null;
    }

    log.info("[BulkSyncStateManager] Found incomplete sync", {
      provider: state.provider,
      processed: state.processedChatIds.length,
      total: state.total,
      ageMinutes: Math.floor(age / (60 * 1000)),
    });

    return state;
  }

  /**
   * Get list of chat IDs that have not been processed yet.
   * Uses Set for O(n) performance instead of O(n²).
   */
  async getRemainingChatIds(): Promise<string[]> {
    const state = await getBulkSyncState();
    if (!state) return [];

    const processedSet = new Set(state.processedChatIds);
    return state.chatIds.filter((chatId) => !processedSet.has(chatId));
  }

  /**
   * Clear persisted state (on completion or cancellation).
   */
  async clearState(): Promise<void> {
    await setBulkSyncState(null);
    log.debug("[BulkSyncStateManager] State cleared");
  }
}

// Export singleton instance
export const bulkSyncStateManager = new BulkSyncStateManager();
