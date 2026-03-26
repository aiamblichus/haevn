/**
 * Transform PI JSONL events to HAEVN.Chat format.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  Chat,
  ChatMessage,
  ModelMessage,
  ModelRequest,
  ModelRequestPart,
  ModelResponse,
  ModelResponsePart,
} from "../../model/haevn_model";
import type {
  PiAssistantMessagePayload,
  PiContentBlock,
  PiLine,
  PiMessageLine,
  PiMessagePayload,
  PiModelChangeLine,
  PiRawExtraction,
  PiToolCallContent,
  PiToolResultMessagePayload,
  PiUserMessagePayload,
} from "./model";

function safeIso(ts: string | undefined): string {
  if (!ts) return new Date().toISOString();
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? new Date().toISOString() : new Date(ms).toISOString();
}

function safeMs(ts: string | undefined): number {
  if (!ts) return Date.now();
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? Date.now() : ms;
}

function extractTextBlocks(content: PiContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
      continue;
    }

    if (block.type === "url") {
      const url = typeof block.url === "string" ? block.url : "";
      const title = typeof block.title === "string" ? block.title : "";
      if (url && title) {
        parts.push(`${title}: ${url}`);
      } else if (url) {
        parts.push(url);
      }
    }
  }

  return parts.join("\n\n").trim();
}

function contentToAssistantParts(content: PiContentBlock[] | undefined): ModelResponsePart[] {
  if (!Array.isArray(content)) return [];

  const parts: ModelResponsePart[] = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;

    if (block.type === "thinking" && typeof block.thinking === "string") {
      parts.push({
        part_kind: "thinking",
        content: block.thinking,
        signature:
          typeof block.thinkingSignature === "string" ? block.thinkingSignature : undefined,
      });
      continue;
    }

    if (block.type === "text" && typeof block.text === "string") {
      parts.push({
        part_kind: "text",
        content: block.text,
      });
      continue;
    }

    if (block.type === "toolCall") {
      const typedBlock = block as PiToolCallContent;
      parts.push({
        part_kind: "tool-call",
        tool_name: typedBlock.name || "unknown_tool",
        args: typedBlock.arguments,
        tool_call_id: typedBlock.id || uuidv4(),
      });
      continue;
    }

    if (block.type === "url") {
      const url = typeof block.url === "string" ? block.url : "";
      const title = typeof block.title === "string" ? block.title : "";
      if (url) {
        parts.push({
          part_kind: "text",
          content: title ? `${title}: ${url}` : url,
        });
      }
    }
  }

  return parts;
}

function messageLineToModelMessage(
  line: PiMessageLine,
  toolNameByCallId: Map<string, string>,
): ModelMessage | null {
  const payload = line.message;
  if (!payload || typeof payload !== "object") return null;

  const tsIso = safeIso(line.timestamp);

  if (isAssistantPayload(payload)) {
    const parts = contentToAssistantParts(payload.content);

    if (parts.length === 0 && payload.errorMessage) {
      parts.push({
        part_kind: "text",
        content: payload.errorMessage,
      });
    }

    if (parts.length === 0) return null;

    return {
      kind: "response",
      parts,
      model_name: typeof payload.model === "string" ? payload.model : undefined,
      usage: payload.usage,
      timestamp: tsIso,
      vendor_id: typeof payload.responseId === "string" ? payload.responseId : undefined,
      vendor_details: {
        api: payload.api,
        provider: payload.provider,
        stopReason: payload.stopReason,
      },
    } satisfies ModelResponse;
  }

  if (isUserPayload(payload)) {
    const text = extractTextBlocks(payload.content);
    if (!text) return null;

    const requestPart: ModelRequestPart = {
      part_kind: "user-prompt",
      content: text,
      timestamp: tsIso,
    };

    return {
      kind: "request",
      parts: [requestPart],
    } satisfies ModelRequest;
  }

  if (isToolResultPayload(payload)) {
    const toolPayload = payload;
    const toolCallId = toolPayload.toolCallId || uuidv4();
    const toolName = toolPayload.toolName || toolNameByCallId.get(toolCallId) || "unknown_tool";

    const requestPart: ModelRequestPart = {
      part_kind: "tool-return",
      tool_name: toolName,
      tool_call_id: toolCallId,
      content: extractTextBlocks(toolPayload.content),
      metadata: {
        details: toolPayload.details,
        isError: toolPayload.isError,
      },
      timestamp: tsIso,
    };

    return {
      kind: "request",
      parts: [requestPart],
    } satisfies ModelRequest;
  }

  return null;
}

function isMessageLine(line: PiLine): line is PiMessageLine {
  return line.type === "message";
}

function isModelChangeLine(line: PiLine): line is PiModelChangeLine {
  return line.type === "model_change";
}

function isAssistantPayload(payload: PiMessagePayload): payload is PiAssistantMessagePayload {
  return payload.role === "assistant";
}

function isUserPayload(payload: PiMessagePayload): payload is PiUserMessagePayload {
  return payload.role === "user";
}

function isToolResultPayload(payload: PiMessagePayload): payload is PiToolResultMessagePayload {
  return payload.role === "toolResult";
}

function extractTitle(extraction: PiRawExtraction): string {
  for (const line of extraction.lines) {
    if (!isMessageLine(line) || !line.message || !isUserPayload(line.message)) continue;

    const text = extractTextBlocks(line.message.content);
    if (!text) continue;

    const firstLine = text.split("\n")[0]?.trim() || "";
    if (!firstLine) continue;

    return firstLine.length > 100 ? `${firstLine.substring(0, 97)}...` : firstLine;
  }

  return "Untitled PI Session";
}

export function transformPiToHaevnChat(extraction: PiRawExtraction): Chat {
  const messages: Record<string, ChatMessage> = {};
  const models = new Set<string>(extraction.metadata.models);
  const toolNameByCallId = new Map<string, string>();

  let previousId: string | undefined;

  for (const line of extraction.lines) {
    if (isModelChangeLine(line)) {
      if (line.modelId) {
        models.add(line.modelId);
      }
      continue;
    }

    if (!isMessageLine(line)) continue;
    if (!line.message) continue;

    if (isAssistantPayload(line.message) && Array.isArray(line.message.content)) {
      for (const block of line.message.content) {
        if (block.type === "toolCall" && block.id && block.name) {
          toolNameByCallId.set(block.id, block.name);
        }
      }

      if (line.message.model) {
        models.add(line.message.model);
      }
    }

    const modelMessage = messageLineToModelMessage(line, toolNameByCallId);
    if (!modelMessage) continue;

    const id = uuidv4();
    const chatMessage: ChatMessage = {
      id,
      parentId: previousId,
      childrenIds: [],
      message: [modelMessage],
      model:
        modelMessage.kind === "response" && typeof modelMessage.model_name === "string"
          ? modelMessage.model_name
          : "",
      done: true,
      timestamp: safeMs(line.timestamp),
      chatId: extraction.sessionId,
    };

    messages[id] = chatMessage;

    if (previousId && messages[previousId]) {
      messages[previousId].childrenIds.push(id);
    }
    previousId = id;
  }

  const messageIds = Object.keys(messages);
  const currentId = messageIds.length > 0 ? messageIds[messageIds.length - 1] : "";

  return {
    id: extraction.sessionId,
    source: "pi",
    sourceId: extraction.sessionId,
    title: extractTitle(extraction),
    models: Array.from(models),
    params: {
      sessionId: extraction.sessionId,
      cwd: extraction.metadata.cwd,
      version: extraction.metadata.version,
      modelProvider: extraction.metadata.modelProvider,
      thinkingLevel: extraction.metadata.thinkingLevel,
    },
    currentId,
    messages,
    tags: [],
    timestamp: extraction.metadata.createdTimestamp,
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: extraction.metadata.lastModifiedTimestamp,
  };
}
