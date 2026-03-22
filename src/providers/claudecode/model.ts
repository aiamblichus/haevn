/**
 * TypeScript type definitions for Claude Code JSONL session format.
 *
 * Claude Code stores session transcripts locally as JSONL files in:
 * ~/.claude/projects/{project-path}/{session-uuid}.jsonl
 *
 * Each line is a complete JSON object representing a message, snapshot, or system event.
 */

/**
 * Base fields common to all Claude Code messages.
 */
export interface ClaudeCodeBaseMessage {
  type: string;
  uuid: string;
  timestamp: string; // ISO 8601 format
  sessionId: string;
  cwd: string;
  gitBranch: string;
  version: string; // Claude Code version (e.g., "2.1.5")
  userType: string; // Usually "external"
  parentUuid: string | null;
  isSidechain: boolean;
}

/**
 * Tool result content block (in user messages after tool use).
 */
export interface ClaudeCodeToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

/**
 * User message content can be a string or array of content blocks.
 * Array content appears when the message contains tool results.
 */
export type ClaudeCodeUserContent =
  | string
  | (ClaudeCodeTextContent | ClaudeCodeToolResultContent)[];

/**
 * User message (user prompt).
 */
export interface ClaudeCodeUserMessage extends ClaudeCodeBaseMessage {
  type: "user";
  message: {
    role: "user";
    content: ClaudeCodeUserContent;
  };
  thinkingMetadata: {
    level: "high" | "medium" | "low";
    disabled: boolean;
    triggers: string[];
  };
  todos: unknown[];
}

/**
 * Content blocks within assistant messages.
 */
export type ClaudeCodeContent =
  | ClaudeCodeTextContent
  | ClaudeCodeToolUseContent
  | ClaudeCodeThinkingContent;

export interface ClaudeCodeTextContent {
  type: "text";
  text: string;
}

export interface ClaudeCodeToolUseContent {
  type: "tool_use";
  id: string; // Tool call ID (e.g., "toolu_012WCd1d3TgxkUbhmN3Wbhks")
  name: string; // Tool name (e.g., "Read", "Edit", "Bash", "Task")
  input: unknown; // Tool-specific input parameters
}

export interface ClaudeCodeThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/**
 * Assistant message (model response).
 */
export interface ClaudeCodeAssistantMessage extends ClaudeCodeBaseMessage {
  type: "assistant";
  requestId: string;
  message: {
    role: "assistant";
    content: ClaudeCodeContent[];
    stop_reason: "end_turn" | "stop_sequence" | "max_tokens" | null;
    model: string; // e.g., "claude-sonnet-4-5-20250929"
  };
}

/**
 * System message (actual system prompt).
 */
export interface ClaudeCodeSystemMessage extends ClaudeCodeBaseMessage {
  type: "system";
  message: {
    role: "system";
    content: string;
  };
}

/**
 * System telemetry message (turn duration, etc.).
 * These don't have a message field, just metadata.
 *
 * Note: Ignored in v1 of importer.
 */
export interface ClaudeCodeSystemTelemetry extends ClaudeCodeBaseMessage {
  type: "system";
  subtype: string; // e.g., "turn_duration"
  durationMs?: number;
  isMeta: boolean;
  slug?: string;
}

/**
 * File history snapshot (for undo/revert functionality).
 * These track file edits made by Claude and are stored separately in:
 * ~/.claude/file-history/{session-uuid}/{hash}@v{version}
 *
 * Note: Ignored in v1 of importer.
 */
export interface ClaudeCodeFileSnapshot {
  type: "file-history-snapshot";
  messageId: string;
  snapshot: {
    messageId: string;
    trackedFileBackups: Record<
      string,
      {
        backupFileName: string | null;
        version: number;
        backupTime: string;
      }
    >;
    timestamp: string;
  };
  isSnapshotUpdate: boolean;
}

/**
 * Summary message (branch summaries in conversation tree).
 * These are auto-generated summaries for conversation branches.
 *
 * Note: Ignored in v1 of importer.
 */
export interface ClaudeCodeSummary {
  type: "summary";
  summary: string;
  leafUuid: string;
}

/**
 * Union of all Claude Code message types.
 */
export type ClaudeCodeMessage =
  | ClaudeCodeUserMessage
  | ClaudeCodeAssistantMessage
  | ClaudeCodeSystemMessage
  | ClaudeCodeSystemTelemetry
  | ClaudeCodeFileSnapshot
  | ClaudeCodeSummary;

/**
 * Session metadata extracted from messages.
 */
export interface ClaudeCodeSessionMetadata {
  sessionId: string; // UUID of the session
  cwd: string; // Working directory
  gitBranch: string; // Git branch name
  version: string; // Claude Code version
  models: string[]; // List of unique models used in session
  createdTimestamp: number; // First message timestamp (ms)
  lastModifiedTimestamp: number; // Last message timestamp (ms)
}

/**
 * Raw extraction result from parsing a JSONL file.
 */
export interface ClaudeCodeRawExtraction {
  sessionId: string;
  messages: ClaudeCodeMessage[];
  metadata: ClaudeCodeSessionMetadata;
  subagents?: Map<string, ClaudeCodeMessage[]>; // agent-id -> messages
}

/**
 * Parsed JSONL session ready for transformation.
 */
export interface ClaudeCodeParsedSession {
  sessionId: string;
  filePath: string; // Original .jsonl file path
  userMessages: ClaudeCodeUserMessage[];
  assistantMessages: ClaudeCodeAssistantMessage[];
  systemMessages: ClaudeCodeSystemMessage[];
  metadata: ClaudeCodeSessionMetadata;
  subagentIds: string[]; // List of detected subagent IDs
}

/**
 * Common tool names used in Claude Code.
 */
export const CLAUDE_CODE_TOOL_NAMES = {
  READ: "Read",
  EDIT: "Edit",
  WRITE: "Write",
  BASH: "Bash",
  TASK: "Task",
  GREP: "Grep",
  GLOB: "Glob",
  ASK_USER_QUESTION: "AskUserQuestion",
  TODO_WRITE: "TodoWrite",
  SKILL: "Skill",
  WEB_FETCH: "WebFetch",
  WEB_SEARCH: "WebSearch",
  NOTEBOOK_EDIT: "NotebookEdit",
  KILL_SHELL: "KillShell",
  TASK_OUTPUT: "TaskOutput",
  ENTER_PLAN_MODE: "EnterPlanMode",
  EXIT_PLAN_MODE: "ExitPlanMode",
} as const;

/**
 * Type guard to check if a message is a user message.
 */
export function isUserMessage(msg: ClaudeCodeMessage): msg is ClaudeCodeUserMessage {
  return msg.type === "user";
}

/**
 * Type guard to check if a message is an assistant message.
 */
export function isAssistantMessage(msg: ClaudeCodeMessage): msg is ClaudeCodeAssistantMessage {
  return msg.type === "assistant";
}

/**
 * Type guard to check if a message is a system message (with content).
 */
export function isSystemMessage(msg: ClaudeCodeMessage): msg is ClaudeCodeSystemMessage {
  return msg.type === "system" && "message" in msg;
}

/**
 * Type guard to check if a message is system telemetry.
 */
export function isSystemTelemetry(msg: ClaudeCodeMessage): msg is ClaudeCodeSystemTelemetry {
  return msg.type === "system" && "subtype" in msg;
}

/**
 * Type guard to check if a message is a file snapshot.
 */
export function isFileSnapshot(msg: ClaudeCodeMessage): msg is ClaudeCodeFileSnapshot {
  return msg.type === "file-history-snapshot";
}

/**
 * Type guard to check if a message is a summary.
 */
export function isSummary(msg: ClaudeCodeMessage): msg is ClaudeCodeSummary {
  return msg.type === "summary";
}
