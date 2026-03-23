// Type-safe message types for Web Worker communication
// Used by search.worker.ts, stats.worker.ts, bulkExport.worker.ts, and import.worker.ts

// ======================
// Search Worker Messages
// ======================

export type SearchWorkerMessage =
  | { type: "init" }
  | { type: "add"; doc: { id: string; title: string; content: string } }
  | { type: "remove"; chatId: string }
  | { type: "removeMany"; chatIds: string[] }
  | {
      type: "search";
      query: string;
      maxResults?: number;
      requestId: string;
      hydrate?: boolean;
      filterProvider?: string;
      contextChars?: number;
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
    }
  | { type: "bulkComplete"; success: boolean; indexedCount: number }
  | {
      type: "indexRebuildProgress";
      progress: { processed: number; total: number; percentage: number };
    }
  | { type: "indexRebuildComplete"; totalChats: number }
  | {
      type: "searchDuringRebuild";
      rebuildProgress: { processed: number; total: number; percentage: number };
    }
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
  | { type: "complete"; processed: number; skipped: number; batches: number }
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

export type BulkSyncWorkerResponse = (
  | {
      type: "progress";
      chatId: string;
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
      chat: import("../model/haevn_model").Chat;
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

import type { Chat } from "../model/haevn_model";
import type { SaveChatResult } from "../services/chatPersistence";

// Import source types
export type ImportSourceType =
  | "chatgpt_zip"
  | "claude_zip"
  | "openwebui_zip"
  | "haevn_export_zip"
  | "claudecode_jsonl";

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
      // Chat skipped (already exists, error, etc.)
      type: "skipped";
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
  | { type: "initComplete"; success: boolean }
  | {
      type: "thumbnailsGenerated";
      chatId: string;
      count: number;
      thumbnails: GalleryMediaItem[];
    }
  | { type: "batchProgress"; processed: number; total: number; chatId: string }
  | { type: "batchComplete"; totalGenerated: number; totalSkipped: number }
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
