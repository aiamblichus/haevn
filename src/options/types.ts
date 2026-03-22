import type { ExportOptions } from "../formatters";
import type { SearchResult } from "../model/haevn_model";

// Re-export canonical types for convenience
export type { SearchResult, ExportOptions };

export type StatusKind = "ok" | "warn" | "error" | "work";

export interface StatusContextValue {
  text: string;
  color: string;
  setStatus: (text: string, kind?: StatusKind) => void;
}

export type SyncStatus = "synced" | "changed" | "error" | "pending" | "new";

export type SortDirection = "asc" | "desc";

export type SortKey = "lastSyncedTimestamp" | "providerLastModifiedTimestamp" | "title";

/**
 * Metadata for a synced chat, used for list views.
 * This is a subset of the full Chat type, containing only the fields needed for display.
 */
export interface ChatMeta {
  id: string;
  source: string;
  title: string;
  lastSyncedTimestamp?: number;
  providerLastModifiedTimestamp?: number;
  syncStatus?: SyncStatus;
  lastSyncAttemptMessage?: string;
  sourceId?: string;
  params?: Record<string, unknown>;
}

export interface ProviderStats {
  downloaded: number;
}

export interface ProviderSyncState {
  isSyncing: boolean;
  progress: number;
  status: string;
  failedCount?: number;
}
