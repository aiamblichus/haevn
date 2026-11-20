// Open WebUI API response types (minimal shapes used by the extractor/transformer)

export interface OpenWebUIMessage {
  // Message objects keyed by message ID in history.messages
  role: string; // "user" | "assistant" | ...
  content: string; // message text content (may contain reasoning details)
  timestamp?: number; // unix seconds
  id?: string; // not always present in docs; we will synthesize if absent
  parentId?: string | null;
  models?: string[]; // model names used for this message
  /**
   * Structured items of an assistant message (Open WebUI 0.12 and later): reasoning items first,
   * then the message item. `content` is then the answer alone. Absent on older messages, which
   * keep their reasoning in `<details type="reasoning">` inside `content`. Other item types
   * (tool calls) are not mapped.
   */
  output?: OpenWebUIOutputItem[];
  /** Set on a failed generation, whose `content` is empty. */
  error?: { content?: string };
  /** False while a message is still generating or was cut off. */
  done?: boolean;
}

export interface OpenWebUIOutputItem {
  type: string; // "reasoning" | "message" | ...
  /** Reasoning text blocks of a "reasoning" item. */
  content?: Array<{ type?: string; text?: string }>;
  /** The same reasoning under another name; read only when `content` has no text. */
  reasoning_details?: Array<{ type?: string; text?: string }>;
  status?: string; // "completed" | "incomplete"
  [key: string]: unknown;
}

export interface OpenWebUIHistory {
  currentId?: string;
  messages?: Record<string, OpenWebUIMessage>;
}

export interface OpenWebUIChat {
  title?: string;
  history?: OpenWebUIHistory;
  models?: string[]; // model names used in this chat
  system?: string; // system prompt can sometimes be here
  params?: {
    system?: string;
    [key: string]: unknown;
  };
  // other fields not needed for extraction
}

export interface OpenWebUIChatResponse {
  id: string;
  user_id: string;
  title: string;
  chat: OpenWebUIChat;
  updated_at: number; // unix seconds
  created_at: number; // unix seconds
  share_id?: string | null;
  archived: boolean;
  pinned?: boolean;
  meta?: Record<string, unknown>;
  folder_id?: string | null;
  system?: string; // chat-level system prompt
}

export interface OpenWebUIFolderResponse {
  id: string;
  parent_id?: string | null;
  user_id: string;
  name: string;
  data?: {
    system_prompt?: string;
    [key: string]: unknown;
  };
}

export type OpenWebUIGetAllChatsResponse = OpenWebUIChatResponse[];

/**
 * Raw extraction result from OpenWebUI extractor.
 * Contains the chat response data and optionally folder system prompts.
 */
export interface OpenWebUIRawExtraction {
  chat: OpenWebUIChatResponse;
  folderSystems?: string[];
}
