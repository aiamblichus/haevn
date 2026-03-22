// ================================
// DeepSeek API Response Types
// ================================

export type DeepseekApiRole = "USER" | "ASSISTANT";
export type DeepseekFragmentType = "REQUEST" | "THINK" | "RESPONSE";
export type DeepseekMessageStatus = "FINISHED" | "PENDING" | "ERROR";

export interface DeepseekApiFragment {
  id: number;
  type: DeepseekFragmentType;
  content: string;
  elapsed_secs?: number; // Present for THINK fragments
  references: unknown[]; // Search references if search_enabled
  stage_id: number;
}

export interface DeepseekApiFile {
  // Structure TBD - API supports files but no sample data available
  id?: string;
  name?: string;
  url?: string;
  type?: string;
}

export interface DeepseekApiMessage {
  message_id: number;
  parent_id: number | null; // Supports branching!
  model: string;
  role: DeepseekApiRole;
  thinking_enabled: boolean;
  ban_edit: boolean;
  ban_regenerate: boolean;
  status: DeepseekMessageStatus;
  accumulated_token_usage: number;
  files: DeepseekApiFile[];
  feedback: unknown | null;
  inserted_at: number; // Unix timestamp with decimals (seconds)
  search_enabled: boolean;
  // Two possible formats - fragments array OR direct fields
  fragments?: DeepseekApiFragment[]; // Format 1: structured fragments
  has_pending_fragment?: boolean;
  auto_continue?: boolean;
  // Format 2: direct content fields
  content?: string;
  thinking_content?: string | null;
  thinking_elapsed_secs?: number | null;
  search_status?: unknown | null;
  search_results?: unknown | null;
  tips?: unknown[];
}

export interface DeepseekApiChatSession {
  id: string; // UUID
  title: string;
  title_type: "SYSTEM" | string;
  pinned: boolean;
  updated_at: number; // Unix timestamp (seconds with decimals)
  seq_id: number;
  agent: "chat" | string;
  version: number;
  current_message_id: number;
  inserted_at: number; // Unix timestamp
}

export interface DeepseekApiBizData {
  chat_session: DeepseekApiChatSession;
  chat_messages: DeepseekApiMessage[];
}

export interface DeepseekApiData {
  biz_code: number;
  biz_msg: string;
  biz_data: DeepseekApiBizData;
}

export interface DeepseekApiResponse {
  code: number; // 0 = success
  msg: string;
  data: DeepseekApiData;
}

export interface DeepseekApiChatListBizData {
  chat_sessions: DeepseekApiChatSession[];
  has_more: boolean;
  lte_cursor?: number;
}

export interface DeepseekApiChatListData {
  biz_code: number;
  biz_msg: string;
  biz_data: DeepseekApiChatListBizData;
}

export interface DeepseekApiChatListResponse {
  code: number;
  msg: string;
  data: DeepseekApiChatListData;
}

// ================================
// Intermediate Type for Transformer
// ================================

// DOM-extracted message format (legacy, from clipboard/DOM extraction)
export interface DeepseekMessage {
  role: "user" | "assistant";
  content: string;
  thinking?: string | null;
  codeBlocks?: DeepseekCodeBlock[];
}

export interface DeepseekCodeBlock {
  language?: string;
  code: string;
}

// Unified conversation data that supports both DOM and API formats
export interface DeepseekConversationData {
  sourceId: string;
  title: string;
  url: string;
  extractedAt: string;
  // API format (preferred)
  session?: DeepseekApiChatSession;
  messages: DeepseekApiMessage[] | DeepseekMessage[];
}

export interface DeepseekChatListItem {
  id: string;
  title?: string;
}
