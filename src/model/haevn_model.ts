// src/model/haevn_model.ts
// TypeScript interfaces translated from the Python Pydantic models.
// This file defines the canonical HAEVN data model as a namespace.

// ======================
// Media Types & File Schemas
// ======================

export type AudioMediaType =
  | "audio/wav"
  | "audio/mpeg"
  | "audio/ogg"
  | "audio/flac"
  | "audio/aiff"
  | "audio/aac";
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type DocumentMediaType =
  | "application/pdf"
  | "text/plain"
  | "text/csv"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "text/html"
  | "text/markdown"
  | "application/vnd.ms-excel";
export type VideoMediaType =
  | "video/x-matroska"
  | "video/quicktime"
  | "video/mp4"
  | "video/webm"
  | "video/x-flv"
  | "video/mpeg"
  | "video/x-ms-wmv"
  | "video/3gpp";

interface FileUrl {
  url: string;
  force_download?: boolean;
  vendor_metadata?: Record<string, unknown>;
}

export interface VideoUrl extends FileUrl {
  kind: "video-url";
}

export interface AudioUrl extends FileUrl {
  kind: "audio-url";
}

export interface ImageUrl extends FileUrl {
  kind: "image-url";
}

export interface DocumentUrl extends FileUrl {
  kind: "document-url";
}

export interface BinaryContent {
  kind: "binary";
  data: string; // Representing bytes as a base64 string for JSON compatibility
  media_type: AudioMediaType | ImageMediaType | DocumentMediaType | VideoMediaType | string;
  identifier?: string;
  vendor_metadata?: Record<string, unknown>;
}

export type UserContent = string | ImageUrl | AudioUrl | DocumentUrl | VideoUrl | BinaryContent;

// ======================
// Message Part Schemas
// ======================

// --- Model Request Parts ---

export interface SystemPromptPart {
  part_kind: "system-prompt";
  content: string;
  timestamp: string; // ISO 8601 format
  dynamic_ref?: string;
}

export interface UserPromptPart {
  part_kind: "user-prompt";
  content: string | UserContent[];
  timestamp: string; // ISO 8601 format
}

export interface ToolReturnPart {
  part_kind: "tool-return";
  tool_name: string;
  content: unknown;
  tool_call_id: string;
  metadata?: Record<string, unknown>;
  timestamp: string; // ISO 8601 format
}

export interface RetryPromptPart {
  part_kind: "retry-prompt";
  content: unknown[] | string;
  tool_name?: string;
  tool_call_id: string;
  timestamp: string; // ISO 8601 format
}

export type ModelRequestPart = SystemPromptPart | UserPromptPart | ToolReturnPart | RetryPromptPart;

// --- Model Response Parts ---

export interface TextPart {
  part_kind: "text";
  content: string;
}

export interface ThinkingPart {
  part_kind: "thinking";
  content: string;
  id?: string;
  signature?: string;
}

export interface ToolCallPart {
  part_kind: "tool-call";
  tool_name: string;
  args?: string | Record<string, unknown>;
  tool_call_id: string;
}

export interface CodeExecutionResult {
  error?: string;
  output?: string;
  files?: Record<string, unknown>[];
}

export interface CodeExecutionPart {
  part_kind: "code-execution";
  uuid: string;
  name: string;
  code: string;
  language?: string;
  result?: CodeExecutionResult;
}

export interface ImageResponsePart {
  part_kind: "image-response";
  content: ImageUrl | BinaryContent;
}

export interface VideoResponsePart {
  part_kind: "video-response";
  content: VideoUrl | BinaryContent;
}

export interface AudioResponsePart {
  part_kind: "audio-response";
  content: AudioUrl | BinaryContent;
}

export interface DocumentResponsePart {
  part_kind: "document-response";
  content: DocumentUrl | BinaryContent;
}

export type ModelResponsePart =
  | TextPart
  | ToolCallPart
  | ThinkingPart
  | CodeExecutionPart
  | ImageResponsePart
  | VideoResponsePart
  | AudioResponsePart
  | DocumentResponsePart;

// ======================
// Message Schemas
// ======================

export interface ModelRequest {
  kind: "request";
  parts: ModelRequestPart[];
  instructions?: string;
}

export interface ModelResponse {
  kind: "response";
  parts: ModelResponsePart[];
  usage?: Record<string, unknown>;
  model_name?: string;
  timestamp: string; // ISO 8601 format
  vendor_details?: Record<string, unknown>;
  vendor_id?: string;
}

export type ModelMessage = ModelRequest | ModelResponse;

// ======================
// Core Chat Data Models
// ======================

export interface StatusHistoryItem {
  done: boolean;
  action: string;
  description: string;
  urls?: string[];
  query?: string;
}

export interface MessageInfo {
  openai?: boolean;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  eval_count?: number;
  eval_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  total_duration?: number;
  load_duration?: number;
}

export interface ChatMessage {
  id: string;
  parentId?: string;
  childrenIds: string[];
  message: ModelMessage[];
  model: string;
  done: boolean;
  context?: unknown;
  statusHistory?: StatusHistoryItem[];
  error?: boolean | Record<string, string>;
  citations?: string[];
  info?: MessageInfo;
  // Unix timestamp in milliseconds (Date.now())
  timestamp?: number;
  chatId: string;
}

export interface Chat {
  id?: string;
  source: string;
  sourceId: string;
  userId?: string;
  title: string;
  models: string[];
  system?: string;
  params: Record<string, unknown>;
  currentId: string;
  messages: { [key: string]: ChatMessage };
  tags: string[];
  // Creation timestamp; Unix timestamp in milliseconds (Date.now())
  timestamp: number;
  files?: Record<string, unknown>[];
  // --- Sync metadata ---
  // Last successful save/update time in local IndexedDB (ms since epoch)
  lastSyncedTimestamp: number;
  // Last modification time reported by the source platform (if available)
  // Stored as Unix timestamp in milliseconds
  providerLastModifiedTimestamp?: number;
  // SHA-256 (or similar) hash of title + messages content for change detection
  checksum: string;
  // Current sync status relative to the source platform
  syncStatus: "synced" | "changed" | "error" | "pending" | "new";
  // Details of any sync errors or warnings from the last attempt
  lastSyncAttemptMessage?: string;
  // Soft delete timestamp; if set, chat is marked for deletion by Janitor
  deletedAt?: number;
  // Indexed deletion flag: 0 = active, 1 = deleted
  // Unlike deletedAt (which may be undefined), this is always defined for efficient indexing
  deleted: 0 | 1;
}

// ======================
// Search Result Types
// ======================

/**
 * Enriched search result with message-level context and snippet.
 * Used by streaming search and getAllMatchesForChat to provide rich search results.
 */
export interface SearchResult {
  chatId: string;
  chatTitle: string;
  source: string;
  messageId: string;
  messageSnippet: string;
  messageContent: string;
  messageRole: "user" | "assistant";
  messageTimestamp?: number;
  params?: Record<string, unknown>;
}

// ======================
// HAEVN Namespace
// ======================
/**
 * The HAEVN namespace provides a canonical, type-safe reference to all
 * data structures in the HAEVN chat archive format. Use this namespace
 * to avoid naming collisions and ensure you're working with the correct
 * canonical types.
 *
 * Example usage:
 * ```typescript
 * import { HAEVN } from './model/haevn_model';
 * const chat: HAEVN.Chat = { ... };
 * ```
 */
// Create namespace with type aliases that reference the exported types
// Using typeof import to avoid circular references while still providing namespace access
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace HAEVN {
  export type AudioMediaType = import("./haevn_model").AudioMediaType;
  export type ImageMediaType = import("./haevn_model").ImageMediaType;
  export type DocumentMediaType = import("./haevn_model").DocumentMediaType;
  export type VideoMediaType = import("./haevn_model").VideoMediaType;
  export type UserContent = import("./haevn_model").UserContent;
  export type VideoUrl = import("./haevn_model").VideoUrl;
  export type AudioUrl = import("./haevn_model").AudioUrl;
  export type ImageUrl = import("./haevn_model").ImageUrl;
  export type DocumentUrl = import("./haevn_model").DocumentUrl;
  export type BinaryContent = import("./haevn_model").BinaryContent;
  export type SystemPromptPart = import("./haevn_model").SystemPromptPart;
  export type UserPromptPart = import("./haevn_model").UserPromptPart;
  export type ToolReturnPart = import("./haevn_model").ToolReturnPart;
  export type RetryPromptPart = import("./haevn_model").RetryPromptPart;
  export type ModelRequestPart = import("./haevn_model").ModelRequestPart;
  export type TextPart = import("./haevn_model").TextPart;
  export type ThinkingPart = import("./haevn_model").ThinkingPart;
  export type ToolCallPart = import("./haevn_model").ToolCallPart;
  export type CodeExecutionPart = import("./haevn_model").CodeExecutionPart;
  export type ImageResponsePart = import("./haevn_model").ImageResponsePart;
  export type VideoResponsePart = import("./haevn_model").VideoResponsePart;
  export type AudioResponsePart = import("./haevn_model").AudioResponsePart;
  export type DocumentResponsePart = import("./haevn_model").DocumentResponsePart;
  export type ModelResponsePart = import("./haevn_model").ModelResponsePart;
  export type ModelRequest = import("./haevn_model").ModelRequest;
  export type ModelResponse = import("./haevn_model").ModelResponse;
  export type ModelMessage = import("./haevn_model").ModelMessage;
  export type StatusHistoryItem = import("./haevn_model").StatusHistoryItem;
  export type MessageInfo = import("./haevn_model").MessageInfo;
  export type ChatMessage = import("./haevn_model").ChatMessage;
  export type Chat = import("./haevn_model").Chat;
  export type SearchResult = import("./haevn_model").SearchResult;
}
