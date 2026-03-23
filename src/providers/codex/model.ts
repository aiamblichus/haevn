/**
 * Type definitions for Codex session JSONL format.
 */

export interface CodexSessionMetaPayload {
  id?: string;
  timestamp?: string;
  cwd?: string;
  originator?: string;
  cli_version?: string;
  source?: string;
  model_provider?: string;
  base_instructions?: {
    text?: string;
  };
}

export interface CodexResponseItemMessageContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface CodexResponseItemMessagePayload {
  type: "message";
  role?: "system" | "developer" | "user" | "assistant" | string;
  content?: CodexResponseItemMessageContent[];
}

export interface CodexResponseItemReasoningPayload {
  type: "reasoning";
  summary?: unknown[];
  content?: string | null;
  encrypted_content?: string | null;
}

export interface CodexResponseItemFunctionCallPayload {
  type: "function_call";
  name?: string;
  call_id?: string;
  arguments?: string;
  status?: string | null;
}

export interface CodexResponseItemFunctionCallOutputPayload {
  type: "function_call_output";
  call_id?: string;
  output?: string;
  status?: string | null;
}

export type CodexResponseItemPayload =
  | CodexResponseItemMessagePayload
  | CodexResponseItemReasoningPayload
  | CodexResponseItemFunctionCallPayload
  | CodexResponseItemFunctionCallOutputPayload;

export type CodexLine =
  | {
      timestamp?: string;
      type: "session_meta";
      payload?: CodexSessionMetaPayload;
    }
  | {
      timestamp?: string;
      type: "response_item";
      payload?: CodexResponseItemPayload;
    }
  | {
      timestamp?: string;
      type: "turn_context";
      payload?: Record<string, unknown>;
    }
  | {
      timestamp?: string;
      type: "event_msg";
      payload?: Record<string, unknown>;
    };

export interface CodexRawExtraction {
  sessionId: string;
  lines: CodexLine[];
  metadata: {
    createdTimestamp: number;
    lastModifiedTimestamp: number;
    cwd?: string;
    originator?: string;
    cliVersion?: string;
    source?: string;
    modelProvider?: string;
    models: string[];
    baseInstructions?: string;
  };
}
