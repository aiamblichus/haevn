// Type-safe message types for Web Worker communication
// Used by search.worker.ts, stats.worker.ts, bulkExport.worker.ts, and import.worker.ts

// ======================
// Search Worker Messages
// ======================

/** Progress of a full index rebuild, as the search worker reports it. */
export interface SearchIndexRebuildStatus {
  processed: number;
  total: number;
  percentage: number;
}

/**
 * The index may be missing chats: the last rebuild failed (what answers is the index from before
 * it), or the index file could not be opened. A successful rebuild or open ends it.
 */
export interface SearchIndexIncompleteStatus {
  error: string;
}

/** What a chat must satisfy to be a result; checked before the chat counts toward the limit. */
export interface SearchFilters {
  /** Earliest chat timestamp, in milliseconds. */
  after?: number;
  /** Latest chat timestamp, in milliseconds. */
  before?: number;
  /** A category of the chat's metadata, or "_unset" for a chat with none. */
  category?: string;
}

export type SearchWorkerMessage =
  | { type: "init" }
  /** The worker reads the chat from the database and makes the indexed text itself (HVN-76). */
  | { type: "add"; chatId: string }
  | { type: "remove"; chatId: string }
  | { type: "removeMany"; chatIds: string[] }
  | {
      type: "search";
      query: string;
      /** Hydrated search: the most chats to return. */
      maxChats?: number;
      /** Hydrated search: the most passages to return from one chat. */
      passagesPerChat?: number;
      requestId: string;
      hydrate?: boolean;
      filterProvider?: string;
      filters?: SearchFilters;
      contextChars?: number;
      /** Hydrated search: only this chat (the "show more" of a result). */
      chatId?: string;
    }
  | { type: "rebuild" }
  | { type: "startBulk" }
  | { type: "endBulk" };

export type SearchWorkerResponse =
  | { type: "initComplete"; success: boolean }
  | { type: "initProgress"; processed: number; total: number; phase: string }
  | { type: "addComplete"; success: boolean }
  | { type: "removeComplete"; success: boolean }
  | {
      type: "searchResult";
      requestId: string;
      results: string[] | import("../model/haevn_model").SearchResult[];
    }
  | {
      type: "searchResultChunk";
      requestId: string;
      results: string[] | import("../model/haevn_model").SearchResult[];
      done: boolean;
      /**
       * On the last chunk of a hydrated search: more chats matched than the limit let through.
       */
      wasLimited?: boolean;
      /**
       * The query has nothing to look for (only punctuation, or only words to leave out), so
       * the search did not run: a sentence for the reader, and `results` is empty.
       */
      queryProblem?: string;
      /**
       * Set when the index is being built and there is no earlier index to answer from (a first
       * run, or an index of another format), so the search was not run. An empty `results` then
       * means "not searched", never "no matches". A rebuild of an index that exists answers from
       * the old one and sets nothing.
       */
      indexRebuilding?: SearchIndexRebuildStatus;
      /**
       * Set when the last rebuild failed or the index file could not be opened: a short or empty
       * `results` may be missing chats.
       */
      indexIncomplete?: SearchIndexIncompleteStatus;
    }
  | { type: "bulkComplete"; success: boolean; indexedCount: number; error?: string }
  | { type: "indexRebuildProgress"; progress: SearchIndexRebuildStatus }
  | { type: "indexRebuildComplete"; totalChats: number }
  /** A rebuild pass ended in failure: the index is part-built until a rebuild succeeds. */
  | { type: "indexRebuildFailed"; error: string }
  | { type: "error"; error: string; requestId?: string };

// ======================
// Stats Worker Messages
// ======================

export type StatsWorkerMessage =
  | { type: "init" }
  | { type: "getProviderStats"; providerName: string; requestId: string }
  | { type: "getAllProviderStats"; providerNames: string[]; requestId: string };

export type StatsWorkerResponse =
  | { type: "initComplete"; success: boolean }
  | { type: "providerStatsResult"; requestId: string; count: number }
  | {
      type: "allProviderStatsResult";
      requestId: string;
      stats: Array<{ key: string; count: number }>;
    }
  | { type: "error"; error: string; requestId?: string };

// ======================
// Bulk Export Worker Messages
// ======================

import type { ExportOptions } from "../formatters";

/** The status the export worker reports while it zips the staged chats. Pause cannot stop that phase. */
export const BULK_EXPORT_ZIP_STATUS = "Building ZIP archive...";
export const BULK_EXPORT_MANIFEST_STATUS = "Finalizing manifest...";

export type BulkExportWorkerMessage = (
  | {
      type: "start";
      chatIds: string[];
      options: ExportOptions;
      exportId: string;
      meta: {
        haevnVersion: string;
        exportVersion: string;
        exportTimestamp: string;
      };
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "processNextBatch" }
  | {
      type: "downloadComplete";
      requestId: string;
      success: boolean;
      downloadId?: number;
      error?: string;
    }
  | {
      type: "browserApiResponse";
      requestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }
) & { requestId?: string };

export type BulkExportWorkerResponse = (
  | {
      type: "progress";
      processed: number;
      total: number;
      status: string;
      processedMedia?: number;
      bytesWritten?: number;
      currentBatch?: number;
      totalBatches?: number;
    }
  | { type: "batchComplete"; batchNumber: number; zipFilename: string }
  | { type: "complete"; processed: number; skipped: number; unmoved?: number; batches: number }
  | { type: "error"; error: string }
  | { type: "paused" }
  | { type: "cancelled" }
  | {
      type: "requestDownload";
      requestId: string;
      dataUrl: string;
      filename: string;
    }
) & { requestId?: string };

// ======================
// Bulk Sync Worker Messages
// ======================

export type BulkSyncWorkerMessage = (
  | {
      type: "sync";
      data: {
        chatId: string;
        platformName: string | undefined;
        hostname: string;
        rawData: unknown;
        origin?: string;
        tabId?: number;
        /** Which run (and which stretch of it) asked: the worker echoes it on its `progress` (HVN-127). */
        runId: string;
      };
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | { type: "reset" }
  | {
      type: "browserApiResponse";
      requestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }
) & { requestId?: string };

/**
 * What the service worker reads of a chat the bulk sync worker has saved: its identity and the
 * sync fields of the chatSynced event. The worker posts this and not the chat, because a chat with
 * inline media can be past Chrome's 64 MB message limit, and offscreen then drops the message
 * (HVN-121).
 */
export type SavedChatSummary = Pick<
  import("../model/haevn_model").Chat,
  | "source"
  | "sourceId"
  | "title"
  | "lastSyncedTimestamp"
  | "syncStatus"
  | "providerLastModifiedTimestamp"
  | "lastSyncAttemptMessage"
> & { id: string };

export type BulkSyncWorkerResponse = (
  | {
      type: "progress";
      chatId: string;
      /** The `runId` of the request this reports on. */
      runId: string;
      success: boolean;
      savedIds?: string[];
      error?: string;
      processed: number;
      failed: number;
      skipped: number;
    }
  | {
      type: "postProcess";
      chatId: string;
      summary: SavedChatSummary;
      isNewChat: boolean;
      platformName: string | undefined;
    }
  | { type: "error"; error: string }
  | { type: "cancelled"; processed: number; failed: number; skipped: number }
  | { type: "paused" }
  | {
      type: "requestBrowserAPI";
      requestId: string;
      api: string;
      operation: string;
      params: unknown;
    }
) & { requestId?: string };

// ======================
// Import Worker Messages
// ======================

import type { SaveChatResult } from "../services/chatPersistence";

// Import source types
export type ImportSourceType =
  | "chatgpt_zip"
  | "claude_zip"
  | "openwebui_zip"
  | "haevn_export_zip"
  | "claudecode_jsonl"
  | "codex_jsonl"
  | "pi_jsonl"
  | "openrouter_json";

export type ImportWorkerMessage = (
  | {
      type: "start";
      importType: ImportSourceType;
      overwriteExisting: boolean;
      // File payload (provided by offscreen document)
      fileData?: {
        name: string;
        type: string;
        size: number;
        data: ArrayBuffer;
      };
      // File payload (streamed via zip.js in worker)
      file?: File;
      // Staged file metadata (used before offscreen converts to fileData)
      stagedFilePath?: string;
      originalFileName?: string;
      originalFileType?: string;
      folderPath?: string;
    }
  | {
      type: "count";
      importType: ImportSourceType;
      fileData?: {
        name: string;
        type: string;
        size: number;
        data: ArrayBuffer;
      };
      file?: File;
      stagedFilePath?: string;
      originalFileName?: string;
      originalFileType?: string;
    }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "cancel" }
  | {
      // CRD-003: Browser API response from service worker
      type: "browserApiResponse";
      requestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }
) & { requestId?: string };

export type ImportWorkerResponse = (
  | {
      type: "progress";
      processed: number;
      total: number;
      status: string;
      phase?: "counting" | "manifest" | "chats" | "media" | "index";
      processedMedia?: number;
      totalMedia?: number;
      bytesWritten?: number;
      totalBytes?: number;
    }
  | {
      // Chat successfully saved to DB (worker did the save)
      type: "saved";
      chatId: string;
      result: SaveChatResult;
    }
  | {
      // Chat skipped: already in the archive and not overwritten
      type: "skipped";
      chatId?: string;
      reason: string;
    }
  | {
      // Chat that could not be parsed or saved; counted apart from skipped
      type: "failed";
      chatId?: string;
      reason: string;
    }
  | {
      // Request service worker to handle post-processing (cache, index, thumbnails)
      type: "postProcess";
      chatId: string;
      result: SaveChatResult;
      isNewChat: boolean;
    }
  | {
      type: "complete";
      processed: number;
      saved: number;
      skipped: number;
      errors: number;
    }
  | {
      type: "error";
      error: string;
    }
  | {
      type: "count";
      count: number;
    }
  | { type: "paused" }
  | { type: "cancelled" }
  | {
      // CRD-003: Request browser API call from service worker
      type: "requestBrowserAPI";
      requestId: string;
      api: string; // e.g., "storage.get", "downloads.download"
      args: unknown[];
    }
) & { requestId?: string };

// ======================
// Starmap Worker Messages
// ======================

import type {
  ConstellationBounds,
  ConstellationLayoutParams,
  ConstellationPoint,
} from "../constellation/core/types";

export type StarmapWorkerMessage =
  | { type: "ping"; requestId: string }
  | {
      type: "computeLayout";
      requestId: string;
      // No vectors: the worker reads them from IndexedDB itself (HVN-93)
      params: ConstellationLayoutParams;
    };

export type StarmapWorkerResponse =
  | { type: "pong"; requestId: string }
  | {
      type: "layoutResult";
      requestId: string;
      points: ConstellationPoint[];
      bounds: ConstellationBounds;
      stats: {
        pointCount: number;
        clusterCount: number;
        durationMs: number;
        projection: "umap";
      };
    }
  | { type: "error"; error: string; requestId?: string };

// ======================
// Thumbnail Worker Messages
// ======================

export interface GalleryMediaItem {
  id: string; // Unique ID (chatId:messageId:partIndex)
  chatId: string;
  chatTitle: string;
  source: string;
  messageId: string;
  mediaType: string; // MIME type (image/* or video/*)
  role: "user" | "assistant";
  thumbnail: string; // Base64 data URL
  content: string; // Original content (base64 or URL)
  timestamp?: number;
}

export type MediaRoleFilter = "all" | "user" | "assistant";
export type MediaTypeFilter = "all" | "image" | "video";

export type ThumbnailWorkerMessage =
  | { type: "init" }
  | { type: "generateForChat"; chatId: string }
  | { type: "generateBatch"; chatIds?: string[]; batchSize?: number }
  | { type: "checkMissing"; requestId: string }
  | {
      type: "getThumbnails";
      requestId: string;
      offset: number;
      limit: number;
      filterProvider?: string;
      filterRole?: MediaRoleFilter;
      filterMediaType?: MediaTypeFilter;
      sortBy?: string;
      sortDirection?: "asc" | "desc";
    }
  | {
      type: "getMediaContent";
      requestId: string;
      chatId: string;
      messageId: string;
    }
  | {
      type: "videoThumbnailResponse";
      requestId: string;
      thumbnailUrl?: string;
      error?: string;
    };

export type ThumbnailWorkerResponse =
  | { type: "initComplete"; success: boolean; requestId?: string }
  | {
      type: "thumbnailsGenerated";
      chatId: string;
      count: number;
      thumbnails: GalleryMediaItem[];
      requestId?: string;
    }
  | { type: "batchProgress"; processed: number; total: number; chatId: string; requestId?: string }
  | { type: "batchComplete"; totalGenerated: number; totalSkipped: number; requestId?: string }
  | {
      type: "missingCount";
      requestId: string;
      count: number;
      chatIds: string[];
    }
  | {
      type: "thumbnailsResult";
      requestId: string;
      items: GalleryMediaItem[];
      total: number;
    }
  | { type: "mediaContentResult"; requestId: string; content: string }
  | {
      type: "requestVideoThumbnail";
      requestId: string;
      videoData: ArrayBuffer | string;
      mimeType: string;
    }
  | { type: "error"; error: string; requestId?: string };
