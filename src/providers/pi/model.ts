/**
 * Type definitions for PI session JSONL format.
 */

export interface PiSessionLine {
  type: "session";
  version?: number;
  id?: string;
  timestamp?: string;
  cwd?: string;
}

export interface PiModelChangeLine {
  type: "model_change";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  provider?: string;
  modelId?: string;
}

export interface PiThinkingLevelChangeLine {
  type: "thinking_level_change";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  thinkingLevel?: string;
}

export interface PiTextContent {
  type: "text";
  text: string;
}

export interface PiThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

export interface PiToolCallContent {
  type: "toolCall";
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface PiUrlContent {
  type: "url";
  url?: string;
  title?: string;
}

export interface PiImageContent {
  type: "image";
  url?: string;
  mediaType?: string;
}

export type PiContentBlock =
  | PiTextContent
  | PiThinkingContent
  | PiToolCallContent
  | PiUrlContent
  | PiImageContent
  | { type: string; [key: string]: unknown };

export interface PiAssistantMessagePayload {
  role: "assistant";
  content?: PiContentBlock[];
  api?: string;
  provider?: string;
  model?: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  timestamp?: number;
  responseId?: string;
  errorMessage?: string;
}

export interface PiUserMessagePayload {
  role: "user";
  content?: PiContentBlock[];
  timestamp?: number;
}

export interface PiToolResultMessagePayload {
  role: "toolResult";
  toolCallId?: string;
  toolName?: string;
  content?: PiContentBlock[];
  details?: Record<string, unknown>;
  isError?: boolean;
  timestamp?: number;
}

export type PiMessagePayload =
  | PiAssistantMessagePayload
  | PiUserMessagePayload
  | PiToolResultMessagePayload
  | {
      role?: string;
      content?: PiContentBlock[];
      timestamp?: number;
      [key: string]: unknown;
    };

export interface PiMessageLine {
  type: "message";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  message?: PiMessagePayload;
}

export interface PiBranchSummaryLine {
  type: "branch_summary";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export interface PiReloadLine {
  type: "reload";
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  [key: string]: unknown;
}

export type PiLine =
  | PiSessionLine
  | PiModelChangeLine
  | PiThinkingLevelChangeLine
  | PiMessageLine
  | PiBranchSummaryLine
  | PiReloadLine
  | {
      type: string;
      id?: string;
      parentId?: string | null;
      timestamp?: string;
      [key: string]: unknown;
    };

export interface PiRawExtraction {
  sessionId: string;
  lines: PiLine[];
  metadata: {
    createdTimestamp: number;
    lastModifiedTimestamp: number;
    cwd?: string;
    version?: number;
    modelProvider?: string;
    models: string[];
    thinkingLevel?: string;
  };
}
