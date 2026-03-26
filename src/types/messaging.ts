/**
 * @file Centralized type-safe messaging system for HAEVN extension
 * @description All message passing between background, content scripts, and UI components uses these types.
 *
 * This file defines the complete contract for inter-component communication in the HAEVN extension.
 * By centralizing message types here, we ensure type safety across all message boundaries and
 * make it easy to see what messages can be sent and received by each component.
 *
 * Message Types:
 * - BackgroundRequest: Messages sent TO the background service worker from UI components
 * - BackgroundResponse: Responses sent FROM the background service worker
 * - BackgroundEvent: Broadcast events sent FROM the background to UI (not request/response pairs)
 * - ContentScriptRequest: Messages sent TO content scripts
 * - ContentScriptResponse: Responses sent FROM content scripts
 * - OffscreenRequest: Messages sent TO the offscreen document from the service worker
 * - OffscreenResponse: Responses sent FROM the offscreen document
 * - OffscreenEvent: Broadcast events sent FROM the offscreen document (not request/response pairs)
 */

import type { BulkSyncOptions, BulkSyncState } from "../background/bulkSync/types";
import type { ExportOptions } from "../formatters";
import type { Chat } from "../model/haevn_model";
import type { DeepseekConversationData } from "../providers/deepseek/model";
import type { ChatMetadataRecord } from "../services/db";
import type { MetadataAIConfig } from "../services/settingsService";
import type { PlatformInfo } from "../utils/platform";

export type { ChatMetadataRecord, MetadataAIConfig };

import type {
  BulkExportWorkerMessage,
  BulkExportWorkerResponse,
  BulkSyncWorkerMessage,
  BulkSyncWorkerResponse,
  ImportSourceType,
  ImportWorkerMessage,
  ImportWorkerResponse,
  SearchWorkerMessage,
  SearchWorkerResponse,
  StatsWorkerMessage,
  StatsWorkerResponse,
  ThumbnailWorkerMessage,
  ThumbnailWorkerResponse,
} from "./workerMessages";

// Import job state type (matches ImportOrchestrator interface)
export interface ImportJobState {
  status: "running" | "paused" | "cancelled" | "complete" | "error";
  importType: ImportSourceType;
  totalChats: number;
  processedChats: number;
  savedChats: number;
  skippedChats: number;
  startTime: number;
  lastUpdateTime: number;
  stagedFilePath?: string;
  originalFileName?: string;
  originalFileType?: string;
  error?: string;
}

// ======================
// Logger Types
// ======================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

export interface LogEntry {
  id: string; // timestamp + random
  timestamp: number; // Date.now()
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  message: string;
  context: string; // "background", "content-tab-123", "popup", etc.
  tabId?: number;
  url?: string;
  data?: unknown;
  stack?: string;
}

export interface LoggerConfig {
  minLevel: number; // LogLevel enum value
  maxEntries: number; // 1000
  persistCount: number; // 500
}

export interface LogFilter {
  context?: string;
  level?: string;
  since?: number;
  match?: string;
}

/**
 * Internal log message type sent from client contexts to background.
 * This bypasses the normal router and is handled directly in background.ts
 */
export type LogMessage = {
  type: "LOG";
  data: {
    level: "DEBUG" | "INFO" | "WARN" | "ERROR";
    message: string;
    data?: unknown;
    stack?: string;
  };
};

// ======================
// Raw Provider Data Types
// ======================
// Union type for all possible raw provider data returned by extractors
// This is intentionally loose since each provider has different raw data structures
export type AllProviderRawData =
  | Record<string, unknown> // Generic object for most providers
  | { conversation: unknown; assets?: unknown } // ChatGPT
  | { chat: unknown } // OpenWebUI
  | DeepseekConversationData;

// ======================
// Background Request Messages
// ======================
/**
 * All messages sent TO the background service worker from UI components.
 *
 * This is a discriminated union based on the `action` property. TypeScript will
 * narrow the type based on the action, ensuring type-safe access to action-specific payloads.
 *
 * @example
 * ```typescript
 * const request: BackgroundRequest = {
 *   action: "getSyncedChatContent",
 *   chatId: "abc123"
 * };
 * ```
 */
export type BackgroundRequest =
  // Sync operations
  | { action: "syncCurrentChat"; tabId: number; options?: ExportOptions }
  | {
      action: "syncChatByUrl";
      url: string;
    }
  | {
      action: "startBulkSync";
      tabId?: number;
      provider: string;
      baseUrl?: string;
      options?: BulkSyncOptions;
    }
  | {
      action: "startBulkSyncFromTab";
      tabId: number;
      baseUrl?: string;
      options?: BulkSyncOptions;
    }
  | { action: "cancelBulkSync" }
  | { action: "getBulkSyncState" }
  | {
      action: "resumeBulkSync";
      provider: string;
    }
  | {
      action: "abandonBulkSync";
      provider: string;
    }
  | { action: "forceResetBulkSync" }
  // Chat management
  | {
      action: "getSyncedChatsMetadata";
      offset?: number;
      limit?: number;
      filterProvider?: string;
      sortBy?: string;
      sortDirection?: "asc" | "desc";
    }
  | { action: "getSyncedChatContent"; chatId: string }
  | { action: "deleteSyncedChats"; chatIds: string[] }
  | { action: "existsChat"; chatId: string }
  | { action: "checkForChanges"; chatId: string }
  | {
      action: "checkCurrentChatSynced";
      platformName?: string;
      conversationId?: string;
      tabId?: number;
    }
  | { action: "getProviderStats"; providerName: string }
  // Export operations
  | {
      action: "exportSyncedChat";
      chatId: string;
      options?: ExportOptions;
    }
  | {
      action: "startBulkExport";
      chatIds: string[];
      options?: ExportOptions;
    }
  | { action: "cancelBulkExport" }
  | { action: "pauseBulkExport" }
  | { action: "resumeBulkExport" }
  | {
      action: "downloadFile";
      content: string;
      filename: string;
      contentType: string;
    }
  // Search operations
  | { action: "searchChats"; query: string; filterProvider?: string }
  | { action: "rebuildIndex" }
  | {
      action: "searchChatsStreaming";
      query: string;
      filterProvider?: string;
      streamBatchSize?: number;
      maxChatsToScan?: number;
      resultsPerChat?: number;
    }
  | { action: "cancelSearchStreaming"; query: string }
  | {
      action: "getAllMatchesForChat";
      query: string;
      chatId: string;
    }
  // Import operations
  | {
      action: "saveImportedChat";
      chat: Chat;
      raw?: AllProviderRawData;
      skipIndexing?: boolean;
    }
  | { action: "startBulkIndexing" }
  | { action: "finishBulkIndexing" }
  | {
      action: "startImportJob";
      importType: ImportSourceType;
      stagedFilePath: string;
      originalFileName?: string;
      originalFileType?: string;
      overwriteExisting?: boolean;
    }
  | { action: "pauseImportJob" }
  | { action: "resumeImportJob" }
  | { action: "cancelImportJob" }
  | { action: "getImportJobState" }
  | {
      action: "countImportConversations";
      importType: ImportSourceType;
      stagedFilePath: string;
      originalFileName?: string;
      originalFileType?: string;
    }
  // Gallery operations
  | {
      action: "getGalleryMedia";
      offset: number;
      limit: number;
      filterProvider?: string;
      filterRole?: string;
      filterMediaType?: string;
      sortBy?: string;
      sortDirection?: "asc" | "desc";
    }
  | { action: "getGalleryContent"; chatId: string; messageId: string }
  | { action: "checkMissingThumbnails" }
  // Settings operations
  | { action: "getOpenWebUIBaseUrl" }
  | { action: "setOpenWebUIBaseUrl"; baseUrl: string }
  | { action: "clearOpenWebUIBaseUrl" }
  | { action: "getCliSettings" }
  | { action: "setCliPort"; port: number }
  | { action: "regenerateCliApiKey" }
  // Logger operations
  | { action: "getLogs"; filter?: LogFilter }
  | { action: "getLoggerConfig" }
  | { action: "setLoggerConfig"; config: Partial<LoggerConfig> }
  | { action: "clearLogs" }
  // Media operations
  | {
      action: "getMediaContent";
      storagePath: string;
    }
  | {
      action: "deleteMedia";
      storagePath: string;
    }
  | { action: "getMediaStats" }
  // Miscellaneous
  | { action: "closeTab"; tabId: number }
  // Gemini image download operations
  | { action: "prepareImageDownload" }
  | { action: "reload" }
  // Metadata operations
  | { action: "getChatMetadata"; chatId: string }
  | { action: "getMetadataForChats"; chatIds: string[] }
  | {
      action: "setChatMetadata";
      chatId: string;
      metadata: Partial<Omit<ChatMetadataRecord, "chatId">>;
    }
  | { action: "generateChatMetadata"; chatId: string }
  | { action: "getMetadataAIConfig" }
  | { action: "setMetadataAIConfig"; config: Partial<MetadataAIConfig> }
  | { action: "queueMissingMetadata" }
  | { action: "getMetadataQueueStatus" };

// ======================
// Background Response Messages
// ======================
/**
 * All responses sent FROM the background service worker.
 *
 * Responses are discriminated by the `success` property. Successful responses
 * may include various data shapes depending on the action, while error responses
 * always include an `error` string.
 *
 * @example
 * ```typescript
 * const response: BackgroundResponse = await chrome.runtime.sendMessage(request);
 * if (response.success && "data" in response) {
 *   const chat = response.data as Chat;
 * }
 * ```
 */
export type BackgroundResponse =
  // Success responses
  | { success: true; data?: unknown }
  | { success: true; chatId?: string }
  | { success: true; state?: BulkSyncState }
  | { success: true; synced: boolean; chatId?: string | null }
  | { success: true; exists: boolean }
  | { success: true; count: number }
  | { success: true; total: number; data: unknown[] }
  | { success: true; total: number; items: unknown[] } // Gallery media response
  | { success: true; results: unknown[] }
  | { success: true; downloadId?: number; filename?: string }
  | {
      success: true;
      processed?: number;
      skipped?: number;
      batches?: number;
      message?: string;
    }
  | { success: true; message?: string }
  | { success: true; baseUrl?: string | null }
  | { success: true; logs: LogEntry[] }
  | { success: true; config: LoggerConfig }
  | {
      success: true;
      content: string | null;
      mimeType: string | null;
    }
  | {
      success: true;
      totalChats: number;
      totalFiles: number;
      estimatedSize: number;
    }
  | { success: true; state: ImportJobState | null }
  // Resume prompt response (Spec 03.02)
  | {
      success: false;
      canResume: true;
      incompleteState: BulkSyncState;
      error: string;
      errorCode: "INCOMPLETE_SYNC_FOUND";
    }
  // Error responses
  | { success: false; error: string; errorCode?: string };

// ======================
// Content Script Request Messages
// ======================
// All messages sent TO content scripts from background or other contexts

export type ContentScriptRequest =
  | { action: "ping" }
  | { action: "detectPlatform" }
  | { action: "getConversationId" }
  | { action: "extractData"; options?: ExportOptions; chatId?: string }
  // Generic provider-agnostic actions
  | { action: "waitForReady"; chatId?: string }
  | { action: "fetchConversation"; chatId: string; platformName?: string; baseUrl?: string }
  // Legacy platform-specific actions (kept for compatibility)
  | { action: "waitForPoeScrollContainer" }
  | { action: "waitForPoePageStable" }
  | { action: "waitForAIStudioContent"; chatId?: string }
  | { action: "getChatIds" }
  | { action: "extractClaudeOrganizationId" }
  | {
      action: "fetchClaudeConversation";
      conversationId?: string;
      chatId?: string;
      organizationId?: string;
    }
  | { action: "getChatGPTAccessToken" }
  | {
      action: "fetchChatGPTConversation";
      conversationId?: string;
      chatId?: string;
      accessToken?: string;
    }
  | { action: "fetchOpenWebUIConversation"; chatId: string }
  | { action: "fetchQwenConversation"; chatId: string }
  | { action: "fetchDeepseekConversation"; chatId: string }
  | { action: "fetchPoeConversation"; chatId: string; baseUrl?: string }
  | { action: "fetchBlob"; url: string; credentials?: RequestCredentials };

// ======================
// Content Script Response Messages
// ======================
// All responses sent FROM content scripts

export type ContentScriptResponse =
  | { status: "ready" }
  | { platform: PlatformInfo }
  | { conversationId: string | null }
  | {
      success: true;
      data: AllProviderRawData;
      platform: PlatformInfo;
    }
  | { success: true; chatIds: string[] }
  | { success: true; organizationId: string }
  | { success: true; accessToken: string }
  | { success: true; data: unknown }
  | { success: false; error: string }
  | { success: true; warning?: string }
  | { success: true; base64: string; contentType: string };

/**
 * Message sent FROM background TO content script when image download completes
 * Used for Gemini high-res image download interception flow
 */
export interface ImageDownloadedMessage {
  action: "imageDownloaded";
  success: boolean;
  blobUrl?: string;
  error?: string;
}

// ======================
// Offscreen Document Request Messages
// ======================
/**
 * All messages sent TO the offscreen document from the service worker.
 *
 * The offscreen document manages iframes for DOM extraction and routes messages to Web Workers.
 * This is a discriminated union based on the `type` property.
 *
 * @example
 * ```typescript
 * const request: OffscreenRequest = {
 *   type: "createIframe",
 *   url: "https://example.com"
 * };
 * ```
 */
export type OffscreenRequest =
  | { type: "ping" }
  | { type: "createIframe"; url: string }
  | { type: "navigateIframe"; url: string }
  | { type: "getIframeInfo" }
  | { type: "deleteStagedFile"; path: string }
  | { type: "createBlobUrl"; path: string }
  | { type: "revokeBlobUrl"; url: string }
  | {
      type: "workerRequest";
      workerType: "search" | "stats" | "bulkExport" | "bulkSync" | "thumbnail" | "import";
      operation: string;
      data:
        | SearchWorkerMessage
        | StatsWorkerMessage
        | BulkExportWorkerMessage
        | BulkSyncWorkerMessage
        | ThumbnailWorkerMessage
        | ImportWorkerMessage;
      requestId?: string;
    };

// ======================
// Offscreen Document Response Messages
// ======================
/**
 * All responses sent FROM the offscreen document.
 *
 * Responses are discriminated by the `success` property. Successful responses
 * may include various data shapes depending on the request type.
 */
export type OffscreenIframeInfo = {
  iframeId: string | null;
  url: string | null;
  ready: boolean;
};

export type OffscreenResponse =
  // Ping response
  | { success: true; ready: boolean; iframeInfo: OffscreenIframeInfo }
  // Iframe operation responses
  | { success: true; iframeInfo: OffscreenIframeInfo }
  // Worker request responses
  | { success: true; result: unknown; requestId?: string }
  | { success: true; url: string }
  // Error responses
  | { success: false; error: string; requestId?: string };

// ======================
// Offscreen Document Event Messages
// ======================
/**
 * Broadcast events sent FROM the offscreen document to the service worker.
 *
 * These are one-way notifications (not request/response pairs). The service worker
 * listens for these events via `chrome.runtime.onMessage.addListener()` to receive
 * real-time updates about iframe state and worker messages.
 *
 * Unlike OffscreenRequest/OffscreenResponse, these events are fire-and-forget
 * and don't require a response from the listener.
 */
export type OffscreenEvent =
  | { type: "offscreenIframeReady"; iframeId: string; url: string }
  | { type: "offscreenIframeNavigated"; iframeId: string; url: string }
  | {
      type: "workerMessage";
      workerType: "search" | "stats" | "bulkExport" | "bulkSync" | "thumbnail" | "import";
      data:
        | SearchWorkerResponse
        | StatsWorkerResponse
        | BulkExportWorkerResponse
        | BulkSyncWorkerResponse
        | ThumbnailWorkerResponse
        | ImportWorkerResponse;
    };

// ======================
// Type Guards
// ======================

export function isBackgroundRequest(message: unknown): message is BackgroundRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "action" in message &&
    typeof (message as { action: unknown }).action === "string"
  );
}

export function isContentScriptRequest(message: unknown): message is ContentScriptRequest {
  if (typeof message !== "object" || message === null) return false;

  return "action" in message && typeof (message as { action: unknown }).action === "string";
}

export function isOffscreenRequest(message: unknown): message is OffscreenRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    typeof (message as { type: unknown }).type === "string"
  );
}

export function isOffscreenEvent(message: unknown): message is OffscreenEvent {
  if (typeof message !== "object" || message === null) return false;

  const msg = message as { type?: unknown };
  if (typeof msg.type !== "string") return false;

  // Check for known offscreen event types
  return (
    msg.type === "offscreenIframeReady" ||
    msg.type === "offscreenIframeNavigated" ||
    msg.type === "workerMessage"
  );
}

export function isLogMessage(message: unknown): message is LogMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    (message as { type: unknown }).type === "LOG" &&
    "data" in message
  );
}

// ======================
// Helper Types for Type-Safe Handlers
// ======================

// Extract the payload type for a specific action
export type RequestPayload<T extends BackgroundRequest["action"]> = Omit<
  Extract<BackgroundRequest, { action: T }>,
  "action"
>;

// Extract the response type for a specific action
// This is a helper type that can be extended as needed
export type ResponseForAction<_T extends BackgroundRequest["action"]> = BackgroundResponse;

// ======================
// Background Event Messages
// ======================
/**
 * Broadcast events sent FROM the background service worker to UI components.
 *
 * These are one-way notifications (not request/response pairs). UI components
 * listen for these events via `chrome.runtime.onMessage.addListener()` to receive
 * real-time updates about sync progress, chat updates, etc.
 *
 * Unlike BackgroundRequest/BackgroundResponse, these events are fire-and-forget
 * and don't require a response from the listener.
 *
 * @example
 * ```typescript
 * chrome.runtime.onMessage.addListener((message: unknown) => {
 *   if (isBackgroundEvent(message)) {
 *     switch (message.action) {
 *       case "chatSynced":
 *         // Handle chat sync event
 *         break;
 *     }
 *   }
 * });
 * ```
 */
export type BackgroundEvent =
  | {
      action: "chatSynced";
      meta: {
        id?: string;
        source: string;
        title: string;
        lastSyncedTimestamp: number;
        syncStatus: "synced" | "changed" | "error" | "pending" | "new";
        providerLastModifiedTimestamp?: number;
        lastSyncAttemptMessage?: string;
      };
    }
  | {
      action: "bulkSyncStarted";
      provider: string;
      baseUrl?: string;
      total: number;
      skippedCount?: number;
    }
  | {
      action: "bulkSyncProgress";
      provider: string;
      baseUrl?: string;
      progress: number;
      status: string;
      failedCount?: number;
      skippedCount?: number;
    }
  | {
      action: "bulkSyncComplete";
      provider: string;
      baseUrl?: string;
      status?: string;
      failedCount?: number;
      skippedCount?: number;
      successCount?: number;
      totalCount?: number;
    }
  | {
      action: "bulkSyncFailed";
      provider: string;
      baseUrl?: string;
      error: string;
    }
  | {
      action: "bulkSyncCanceled";
      provider: string;
      baseUrl?: string;
      status?: string;
    }
  | {
      action: "bulkExportStarted";
      totalChats: number;
      totalBatches: number;
    }
  | {
      action: "bulkExportProgress";
      processed: number;
      total: number;
      currentBatch?: number;
      totalBatches?: number;
      status?: string;
      downloadedFiles?: string[];
    }
  | {
      action: "bulkExportComplete";
      message?: string;
    }
  | {
      action: "bulkExportCanceled";
      status?: string;
    }
  | {
      action: "bulkExportFailed";
      error: string;
    }
  | {
      action: "bulkExportPaused";
      status?: string;
    }
  | {
      action: "bulkExportResumed";
      status?: string;
    }
  | {
      action: "importProgress";
      processed: number;
      total: number;
      saved?: number;
      skipped?: number;
      status?: string;
      phase?: "counting" | "manifest" | "chats" | "media" | "index";
      processedMedia?: number;
      totalMedia?: number;
      bytesWritten?: number;
      totalBytes?: number;
    }
  | {
      action: "importComplete";
      processed: number;
      saved: number;
      skipped: number;
    }
  | {
      action: "importFailed";
      error: string;
    }
  | {
      action: "importPaused";
    }
  | {
      action: "importCancelled";
      processed?: number;
      saved?: number;
      skipped?: number;
    }
  | {
      action: "searchStreamingStarted";
      query: string;
      filterProvider?: string;
    }
  | {
      action: "searchStreamingResults";
      query: string;
      filterProvider?: string;
      results: unknown[];
    }
  | {
      action: "searchStreamingComplete";
      query: string;
      filterProvider?: string;
      totalResults: number;
      chatsScanned: number;
      durationMs: number;
      wasLimited: boolean;
    }
  | {
      action: "searchStreamingFailed";
      query: string;
      filterProvider?: string;
      error: string;
    }
  | {
      action: "providerStatsUpdated";
      providerName: string;
      count: number;
    }
  | {
      action: "metadataGenerated";
      chatId: string;
      /** The resolved display title after generation. */
      title: string;
    }
  | {
      action: "metadataGenerationFailed";
      chatId: string;
      error: string;
    };
