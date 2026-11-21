// Types for bulk sync operations

export interface BulkSyncOptions {
  overwriteExisting?: boolean;
  [key: string]: unknown;
}

export interface BulkSyncProgress {
  provider: string;
  baseUrl?: string;
  progress: number;
  status: string;
}

export interface BulkSyncState {
  // "discovering" is a run that holds the lock and is still looking for its chats: no chat ids yet,
  // `total` 0 (HVN-126). It is not resumable and is never written by the tick.
  status: "discovering" | "running" | "paused" | "complete" | "error" | "cancelled";
  provider: string;
  tabId: number; // Legacy, kept for backward compatibility
  extractionTabId: number | null; // Tab used for extraction chat IDs and individual chats
  baseUrl?: string;
  // The run's whole list, in the order the tick works through it, and never replaced: `total` is
  // its length and `currentIndex` the chats handed over so far, so the two always agree on when
  // the run is over (HVN-124). A resume reorders the list, it does not shorten it.
  chatIds: string[];
  total: number;
  currentIndex: number;
  isCancelled: boolean; // Keep for compatibility with tick handler, but status is better
  failedSyncs: Array<{ chatId: string; error: string }>;
  skippedCount: number;
  platformName: string | undefined;
  overwriteExisting: boolean;
  isProcessing?: boolean; // Re-entrancy guard

  // Resume functionality (Spec 03.02)
  startedAt: number; // Timestamp when sync started
  lastProgressAt: number; // Timestamp of last progress update
  // Chats the tick is done with: handed to the worker (not necessarily saved yet) or failed to
  // fetch. The worker's report settles a hand-off; `bulkSyncPendingHandoffs` says which are open.
  processedChatIds: string[];
  // How many times the run has been resumed after a restart; absent is 0. With `startedAt` it tells
  // the worker's reports of this stretch of the run from an earlier one's (HVN-127).
  resumeCount?: number;
}
