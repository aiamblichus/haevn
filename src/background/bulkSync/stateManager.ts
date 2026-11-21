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

/** What `resumeBulkSync` writes into the state of an interrupted run. */
export interface ResumePlan {
  /** The run's whole list: the settled chats, then those to fetch again, then those not yet fetched. */
  chatIds: string[];
  /** `chatIds.length`, so the run is over exactly when `currentIndex` reaches it. */
  total: number;
  /** The settled chats: where the tick takes up. */
  currentIndex: number;
  processedChatIds: string[];
  failedSyncs: BulkSyncState["failedSyncs"];
  /** Chats handed to the worker and not reported on before the restart: fetched again. */
  refetched: string[];
}

/**
 * Plans how an interrupted run goes on (HVN-124, HVN-127). `pendingChatIds` are the hand-offs the
 * worker had not reported on when the service worker went away. A chat counts as handed over only
 * when the worker settled it, so those go back in front of the chats not yet fetched: nothing is
 * dropped, and a chat the worker did save is simply saved again. The list stays the run's whole list
 * and `total` its length, so a run with few chats left still ends when its index reaches `total`.
 */
export function planResume(
  state: Pick<BulkSyncState, "chatIds" | "processedChatIds" | "failedSyncs">,
  pendingChatIds: string[],
): ResumePlan {
  // A run resumed by an earlier version had its list replaced by the chats still to do, and kept the
  // settled ones only in processedChatIds: the union is the whole list either way.
  const all = [...new Set([...state.processedChatIds, ...state.chatIds])];
  const processed = new Set(state.processedChatIds);
  const pending = new Set(pendingChatIds);
  const settled = state.processedChatIds.filter((id) => !pending.has(id));
  const refetched = state.processedChatIds.filter((id) => pending.has(id));
  const chatIds = [...settled, ...refetched, ...all.filter((id) => !processed.has(id))];
  const refetching = new Set(refetched);
  return {
    chatIds,
    total: chatIds.length,
    currentIndex: settled.length,
    processedChatIds: settled,
    // A report that failed the chat may have landed just before the restart: it is fetched again
    failedSyncs: state.failedSyncs.filter((f) => !refetching.has(f.chatId)),
    refetched,
  };
}

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
   * Clear persisted state (on completion or cancellation).
   */
  async clearState(): Promise<void> {
    await setBulkSyncState(null);
    log.debug("[BulkSyncStateManager] State cleared");
  }
}

// Export singleton instance
export const bulkSyncStateManager = new BulkSyncStateManager();
