import type { BulkSyncState } from "../background/bulkSync/types";

/** What the popup and the Providers page show of a bulk sync: one reading of the state for both. */
export interface BulkSyncView {
  /** A run for this provider holds the lock: show the in-progress view and its Stop button. */
  active: boolean;
  /** The run is still looking for its chats: no total yet, so no percentage (HVN-126). */
  discovering: boolean;
  /** 0 to 100; 0 while discovering, when the total is 0. */
  percent: number;
}

export const DISCOVERING_LABEL = "Discovering chats...";

/**
 * Reads a bulk sync state for one provider. A run counts as active from the moment it holds the
 * lock (`discovering`) until it ends (`running`); a paused, cancelled or finished state does not.
 */
export function bulkSyncViewFor(
  state: BulkSyncState | null | undefined,
  provider: string | undefined,
): BulkSyncView {
  const none = { active: false, discovering: false, percent: 0 };
  if (!state || !provider || state.provider !== provider) return none;
  if (state.status === "discovering") return { active: true, discovering: true, percent: 0 };
  if (state.status !== "running") return none;
  const percent = state.total > 0 ? (state.currentIndex / state.total) * 100 : 0;
  return { active: true, discovering: false, percent };
}

/** True while a run is discovering or running, whichever provider it is for. */
export function isBulkSyncActive(state: BulkSyncState | null | undefined): boolean {
  return state?.status === "running" || state?.status === "discovering";
}
