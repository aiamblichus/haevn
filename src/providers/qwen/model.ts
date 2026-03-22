/**
 * TypeScript interfaces for Qwen API responses
 */

export interface QwenChatListItem {
  id: string;
  title: string;
  updated_at: number; // Unix timestamp in seconds
  created_at: number; // Unix timestamp in seconds
  chat_type: "t2t" | "t2i" | "search" | "image_edit";
}

export interface QwenChatListResponse {
  success: boolean;
  request_id: string;
  data: QwenChatListItem[];
}

export interface QwenFile {
  id: string;
  name: string;
  file_type: string;
  type: string;
  file_class?: string;
  size: number;
  url: string;
  file?: {
    created_at: number;
    data: unknown;
    filename: string;
    hash: string | null;
    id: string;
    user_id: string;
    meta: {
      name: string;
      size: number;
      content_type: string;
    };
    update_at: number;
  };
  collection_name?: string;
  progress?: number;
  status?: string;
  greenNet?: string;
  error?: string;
  itemId?: string;
  showType?: string;
  uploadTaskId?: string;
}

export interface QwenContentListItem {
  content: string;
  phase: "image_gen" | "think" | "answer" | "web_search" | string;
  status?: "typing" | "finished";
  extra?: {
    output_image_hw?: number[][];
    web_search_info?: Array<{
      url: string;
      title: string;
      snippet: string;
      hostname: string | null;
      hostlogo: string | null;
      date: string;
    }>;
    [key: string]: unknown;
  };
  role?: "assistant";
  usage?: Record<string, unknown>;
}

export interface QwenMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  reasoning_content?: string | null;
  chat_type: "t2t" | "t2i" | "search" | "image_edit";
  sub_chat_type?: string | null;
  model?: string;
  modelName?: string;
  modelIdx?: number;
  parentId: string | null;
  childrenIds: string[];
  feature_config?: {
    thinking_enabled?: boolean;
    output_schema?: string | null;
    instructions?: string | null;
    thinking_budget?: number;
    research_mode?: string;
  };
  content_list?: QwenContentListItem[] | null;
  is_stop?: boolean;
  edited?: boolean;
  error?: string | null;
  meta?: Record<string, unknown>;
  extra?: {
    meta?: {
      subChatType?: string;
    };
    endTime?: number;
    [key: string]: unknown;
  };
  feedbackId?: string | null;
  turn_id?: string | null;
  annotation?: string | null;
  done?: boolean;
  info?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: {
      reasoning_tokens?: number;
    };
    openai?: boolean;
    usage?: Record<string, unknown>;
    suggest?: string[];
  } | null;
  timestamp: number; // Unix timestamp in seconds
  models?: string[];
  files?: QwenFile[];
}

export interface QwenChatHistory {
  messages: { [key: string]: QwenMessage };
  currentId: string;
  currentResponseIds: string[];
}

export interface QwenChatData {
  id: string;
  user_id: string;
  title: string;
  chat: {
    history: QwenChatHistory;
    models: string[];
    messages: QwenMessage[];
  };
  updated_at: number; // Unix timestamp in seconds
  created_at: number; // Unix timestamp in seconds
  share_id?: string | null;
  archived?: boolean;
  pinned?: boolean;
  meta?: {
    timestamp?: number;
    tags?: string[];
    [key: string]: unknown;
  };
  folder_id?: string | null;
  currentResponseIds?: string[];
  currentId?: string;
  chat_type: "t2t" | "t2i" | "search" | "image_edit";
  models?: string[] | null;
}

export interface QwenChatResponse {
  success: boolean;
  request_id: string;
  data: QwenChatData;
}
