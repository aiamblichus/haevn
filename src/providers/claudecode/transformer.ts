/**
 * Transform Claude Code messages to HAEVN.Chat format.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  Chat,
  ChatMessage,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  RequestPart,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolReturnPart,
  UserPromptPart,
} from "../../model/haevn_model";
import type {
  ClaudeCodeContent,
  ClaudeCodeMessage,
  ClaudeCodeRawExtraction,
  ClaudeCodeUserContent,
} from "./model";
import {
  isAssistantMessage,
  isFileSnapshot,
  isSummary,
  isSystemMessage,
  isSystemTelemetry,
  isUserMessage,
} from "./model";

/**
 * Transform a parsed Claude Code session to HAEVN.Chat format.
 *
 * @param extraction - Parsed Claude Code session
 * @returns HAEVN.Chat object
 */
export function transformToHaevnChat(extraction: ClaudeCodeRawExtraction): Chat {
  const messages: { [key: string]: ChatMessage } = {};
  const messageIdMap = new Map<string, string>(); // Claude UUID -> HAEVN ID
  const models = new Set<string>();

  console.log(
    `[ClaudeCodeTransformer] Input: ${extraction.messages.length} total messages, sessionId: ${extraction.sessionId}`,
  );

  // Build a map of all Claude messages by UUID for ancestor lookup
  const allMessagesByUuid = new Map<string, ClaudeCodeMessage>();
  for (const msg of extraction.messages) {
    const uuid = (msg as { uuid?: string }).uuid;
    if (uuid) {
      allMessagesByUuid.set(uuid, msg);
    }
  }

  // Determine which messages will be kept (not filtered)
  const keptUuids = new Set<string>();
  for (const msg of extraction.messages) {
    if (!isFileSnapshot(msg) && !isSummary(msg) && !isSystemTelemetry(msg)) {
      const uuid = (msg as { uuid?: string }).uuid;
      if (uuid) {
        keptUuids.add(uuid);
      }
    }
  }

  // Filter out file snapshots, summaries, and system telemetry (ignore for v1)
  const relevantMessages = extraction.messages.filter(
    (msg) => !isFileSnapshot(msg) && !isSummary(msg) && !isSystemTelemetry(msg),
  );

  console.log(
    `[ClaudeCodeTransformer] After filtering: ${relevantMessages.length} relevant messages`,
  );

  // Use session ID as chat ID to prevent duplicates on re-import
  const chatId = extraction.sessionId;

  // Helper to find the nearest kept ancestor
  const findKeptAncestor = (parentUuid: string | null): string | null => {
    let currentUuid = parentUuid;
    while (currentUuid) {
      if (keptUuids.has(currentUuid)) {
        return currentUuid;
      }
      // Walk up to the parent
      const parentMsg = allMessagesByUuid.get(currentUuid);
      if (!parentMsg) break;
      currentUuid = (parentMsg as { parentUuid?: string | null }).parentUuid ?? null;
    }
    return null;
  };

  // === PASS 1: Build messageIdMap for all relevant messages ===
  // This ensures all UUIDs are mapped before we try to look up parents
  for (const claudeMsg of relevantMessages) {
    const msgUuid = (claudeMsg as { uuid: string }).uuid;
    if (!msgUuid) continue;

    const haevnId = uuidv4();
    messageIdMap.set(msgUuid, haevnId);
  }

  // === PASS 2: Create ChatMessage objects using the complete map ===
  for (const claudeMsg of relevantMessages) {
    const msgUuid = (claudeMsg as { uuid: string }).uuid;
    if (!msgUuid) continue;

    const haevnId = messageIdMap.get(msgUuid);
    if (!haevnId) continue;

    // Transform the message content to ModelMessage
    const modelMessage = transformToModelMessage(claudeMsg);
    if (!modelMessage) continue;

    // Track models used
    if (isAssistantMessage(claudeMsg) && claudeMsg.message.model) {
      models.add(claudeMsg.message.model);
    }

    // Get parent ID - find nearest kept ancestor if direct parent was filtered
    const claudeParentUuid = (claudeMsg as { parentUuid: string | null }).parentUuid;
    const keptAncestorUuid = findKeptAncestor(claudeParentUuid);
    const parentId = keptAncestorUuid ? messageIdMap.get(keptAncestorUuid) : undefined;

    // Create ChatMessage
    const chatMessage: ChatMessage = {
      id: haevnId,
      parentId,
      childrenIds: [], // Will be populated later
      message: [modelMessage],
      model: isAssistantMessage(claudeMsg) ? claudeMsg.message.model : "",
      done: true,
      timestamp: new Date((claudeMsg as { timestamp: string }).timestamp).getTime(),
      chatId,
    };

    messages[haevnId] = chatMessage;
  }

  // Populate childrenIds by iterating through messages
  for (const msg of Object.values(messages)) {
    if (msg.parentId && messages[msg.parentId]) {
      if (!messages[msg.parentId].childrenIds.includes(msg.id)) {
        messages[msg.parentId].childrenIds.push(msg.id);
      }
    }
  }

  // Find the last message (currentId)
  const messageList = Object.values(messages);
  const lastMessage = messageList.length > 0 ? messageList[messageList.length - 1] : null;
  const currentId = lastMessage?.id ?? "";

  // Debug: count roots and check parts
  const rootCount = messageList.filter((m) => !m.parentId).length;
  const totalParts = messageList.reduce((sum, m) => sum + (m.message?.[0]?.parts?.length ?? 0), 0);
  console.log(
    `[ClaudeCodeTransformer] Result: ${messageList.length} messages, ${rootCount} roots, ${totalParts} total parts`,
  );

  // Extract title
  const title = extractTitle(relevantMessages);

  return {
    id: chatId,
    source: "claudecode",
    sourceId: extraction.sessionId,
    title,
    models: Array.from(models),
    params: {
      sessionId: extraction.sessionId,
      cwd: extraction.metadata.cwd,
      gitBranch: extraction.metadata.gitBranch,
      claudeVersion: extraction.metadata.version,
    },
    currentId,
    messages,
    tags: [],
    timestamp: extraction.metadata.createdTimestamp,
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: extraction.metadata.lastModifiedTimestamp,
  };
}

/**
 * Transform a Claude Code message to ModelMessage.
 */
function transformToModelMessage(message: ClaudeCodeMessage): ModelMessage | null {
  if (isUserMessage(message)) {
    return transformUserMessage(message);
  }

  if (isAssistantMessage(message)) {
    return transformAssistantMessage(message);
  }

  if (isSystemMessage(message)) {
    return transformSystemMessage(message);
  }

  return null;
}

/**
 * Transform user message to ModelRequest.
 * Handles both string content (regular prompts) and array content (tool results).
 */
function transformUserMessage(message: ClaudeCodeMessage): ModelRequest {
  if (!isUserMessage(message)) {
    throw new Error("Expected user message");
  }

  const parts: RequestPart[] = [];
  const content = message.message.content;

  if (typeof content === "string") {
    // Simple user prompt
    parts.push({
      part_kind: "user-prompt",
      content,
      timestamp: new Date(message.timestamp).getTime(),
    } as UserPromptPart);
  } else if (Array.isArray(content)) {
    // Array content - can contain text blocks and tool results
    for (const block of content) {
      if (block.type === "text") {
        parts.push({
          part_kind: "user-prompt",
          content: block.text,
          timestamp: new Date(message.timestamp).getTime(),
        } as UserPromptPart);
      } else if (block.type === "tool_result") {
        parts.push({
          part_kind: "tool-return",
          tool_call_id: block.tool_use_id,
          content: block.content,
          is_error: block.is_error,
        } as ToolReturnPart);
      }
    }
  }

  // Ensure at least one part exists
  if (parts.length === 0) {
    parts.push({
      part_kind: "user-prompt",
      content: "[Empty message]",
      timestamp: new Date(message.timestamp).getTime(),
    } as UserPromptPart);
  }

  return {
    kind: "request",
    parts,
    timestamp: message.timestamp,
    vendor_id: message.uuid,
  };
}

/**
 * Transform assistant message to ModelResponse.
 */
function transformAssistantMessage(message: ClaudeCodeMessage): ModelResponse {
  if (!isAssistantMessage(message)) {
    throw new Error("Expected assistant message");
  }

  const parts: (TextPart | ThinkingPart | ToolCallPart)[] = [];

  // Transform content blocks to parts
  for (const content of message.message.content) {
    const part = transformContentBlock(content);
    if (part) {
      parts.push(part);
    }
  }

  return {
    kind: "response",
    parts,
    timestamp: message.timestamp,
    model_name: message.message.model,
    vendor_id: message.uuid,
  };
}

/**
 * Transform system message to ModelRequest with system prompt.
 */
function transformSystemMessage(message: ClaudeCodeMessage): ModelRequest {
  if (!isSystemMessage(message)) {
    throw new Error("Expected system message");
  }

  const part: SystemPromptPart = {
    part_kind: "system-prompt",
    content: message.message.content,
    timestamp: new Date(message.timestamp).getTime(),
  };

  return {
    kind: "request",
    parts: [part],
    timestamp: message.timestamp,
    vendor_id: message.uuid,
  };
}

/**
 * Transform a content block to HAEVN part.
 */
function transformContentBlock(
  content: ClaudeCodeContent,
): TextPart | ThinkingPart | ToolCallPart | null {
  switch (content.type) {
    case "text":
      return {
        part_kind: "text",
        content: content.text,
      };

    case "tool_use":
      return {
        part_kind: "tool-call",
        tool_name: content.name,
        args: content.input,
        tool_call_id: content.id,
      };

    case "thinking":
      return {
        part_kind: "thinking",
        content: content.thinking,
      };

    default:
      return null;
  }
}

/**
 * Extract title from messages.
 */
function extractTitle(messages: ClaudeCodeMessage[]): string {
  const firstUserMessage = messages.find(isUserMessage);

  if (firstUserMessage?.message.content) {
    const content = firstUserMessage.message.content;
    // Handle both string and array content
    const textContent =
      typeof content === "string"
        ? content
        : content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join(" ");

    if (textContent) {
      const trimmed = textContent.trim();
      const firstLine = trimmed.split("\n")[0];
      return firstLine.length > 100 ? `${firstLine.substring(0, 97)}...` : firstLine;
    }
  }

  return "Untitled Claude Code Session";
}
