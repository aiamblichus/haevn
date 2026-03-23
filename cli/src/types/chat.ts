/**
 * Shared types copied from the extension.
 * These are the canonical HAEVN data model types needed by the CLI.
 *
 * Source: src/model/haevn_model.ts
 */

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
  data: string; // base64 encoded
  media_type: AudioMediaType | ImageMediaType | DocumentMediaType | VideoMediaType | string;
  identifier?: string;
  vendor_metadata?: Record<string, unknown>;
}

export type UserContent = string | ImageUrl | AudioUrl | DocumentUrl | VideoUrl | BinaryContent;

// ======================
// Message Part Schemas
// ======================

export interface SystemPromptPart {
  part_kind: "system-prompt";
  content: string;
  timestamp: string;
  dynamic_ref?: string;
}

export interface UserPromptPart {
  part_kind: "user-prompt";
  content: string | UserContent[];
  timestamp: string;
}

export interface ToolReturnPart {
  part_kind: "tool-return";
  tool_name: string;
  content: unknown;
  tool_call_id: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface RetryPromptPart {
  part_kind: "retry-prompt";
  content: unknown[] | string;
  tool_name?: string;
  tool_call_id: string;
  timestamp: string;
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
  timestamp: string;
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
  timestamp: number;
  files?: Record<string, unknown>[];
  // Sync metadata
  lastSyncedTimestamp: number;
  providerLastModifiedTimestamp?: number;
  checksum: string;
  syncStatus: "synced" | "changed" | "error" | "pending" | "new";
  lastSyncAttemptMessage?: string;
  deletedAt?: number;
  deleted: 0 | 1;
}

// ======================
// Search Result Types
// ======================

export interface SearchResult {
  chatId: string;
  chatTitle: string;
  source: string;
  messageId: string;
  messageSnippet: string;
  messageContent: string;
  messageRole: "user" | "assistant";
  messageTimestamp?: number;
  model?: string;
  params?: Record<string, unknown>;
}
