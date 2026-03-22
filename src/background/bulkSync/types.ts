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
  // Add a status field to be more explicit
  status: "running" | "paused" | "complete" | "error" | "cancelled";
  provider: string;
  tabId: number; // Legacy, kept for backward compatibility
  extractionTabId: number | null; // Tab used for extraction chat IDs and individual chats
  baseUrl?: string;
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
  processedChatIds: string[]; // Successfully processed chat IDs
}
