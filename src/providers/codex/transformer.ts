/**
 * Transform Codex JSONL events to HAEVN.Chat format.
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
  CodexLine,
  CodexRawExtraction,
  CodexResponseItemFunctionCallOutputPayload,
  CodexResponseItemFunctionCallPayload,
  CodexResponseItemMessagePayload,
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

function flattenTextContent(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const typedItem = item as { type?: string; text?: string };
    if (
      (typedItem.type === "input_text" || typedItem.type === "output_text") &&
      typeof typedItem.text === "string"
    ) {
      parts.push(typedItem.text);
    }
  }

  return parts.join("\n\n").trim();
}

function messagePayloadToModelMessage(
  payload: CodexResponseItemMessagePayload,
  timestampIso: string,
): ModelMessage | null {
  const role = payload.role || "assistant";
  const content = flattenTextContent(payload.content);

  if (role === "assistant") {
    const parts: ModelResponsePart[] = [];
    if (content) {
      parts.push({
        part_kind: "text",
        content,
      });
    }
    if (parts.length === 0) return null;

    const response: ModelResponse = {
      kind: "response",
      parts,
      timestamp: timestampIso,
    };
    return response;
  }

  const isSystemLike = role === "system" || role === "developer";
  const requestPart: ModelRequestPart = isSystemLike
    ? {
        part_kind: "system-prompt",
        content: role === "developer" ? `[Developer]\n${content}` : content,
        timestamp: timestampIso,
        dynamic_ref: role === "developer" ? "developer" : undefined,
      }
    : {
        part_kind: "user-prompt",
        content,
        timestamp: timestampIso,
      };

  const request: ModelRequest = {
    kind: "request",
    parts: [requestPart],
  };
  return request;
}

function functionCallPayloadToModelMessage(
  payload: CodexResponseItemFunctionCallPayload,
  timestampIso: string,
): ModelMessage {
  let parsedArgs: string | Record<string, unknown> | undefined;
  if (payload.arguments) {
    try {
      parsedArgs = JSON.parse(payload.arguments) as Record<string, unknown>;
    } catch {
      parsedArgs = payload.arguments;
    }
  }

  const response: ModelResponse = {
    kind: "response",
    parts: [
      {
        part_kind: "tool-call",
        tool_name: payload.name || "unknown_tool",
        args: parsedArgs,
        tool_call_id: payload.call_id || uuidv4(),
      },
    ],
    timestamp: timestampIso,
  };

  return response;
}

function functionCallOutputPayloadToModelMessage(
  payload: CodexResponseItemFunctionCallOutputPayload,
  timestampIso: string,
  toolNameByCallId: Map<string, string>,
): ModelMessage {
  const toolCallId = payload.call_id || uuidv4();
  const request: ModelRequest = {
    kind: "request",
    parts: [
      {
        part_kind: "tool-return",
        tool_name: toolNameByCallId.get(toolCallId) || "unknown_tool",
        tool_call_id: toolCallId,
        content: payload.output || "",
        timestamp: timestampIso,
      },
    ],
  };
  return request;
}

function lineToModelMessage(
  line: CodexLine,
  toolNameByCallId: Map<string, string>,
): ModelMessage | null {
  if (line.type !== "response_item" || !line.payload) return null;

  const tsIso = safeIso(line.timestamp);

  switch (line.payload.type) {
    case "message":
      return messagePayloadToModelMessage(line.payload, tsIso);
    case "reasoning":
      // Reasoning blocks in Codex session logs are encrypted/non-readable.
      // Skip importing them to avoid noisy unusable content.
      return null;
    case "function_call":
      if (line.payload.call_id && line.payload.name) {
        toolNameByCallId.set(line.payload.call_id, line.payload.name);
      }
      return functionCallPayloadToModelMessage(line.payload, tsIso);
    case "function_call_output":
      return functionCallOutputPayloadToModelMessage(line.payload, tsIso, toolNameByCallId);
    default:
      return null;
  }
}

function extractTitle(extraction: CodexRawExtraction): string {
  for (const line of extraction.lines) {
    if (line.type !== "response_item" || !line.payload || line.payload.type !== "message") {
      continue;
    }
    if (line.payload.role !== "user") continue;
    const text = flattenTextContent(line.payload.content);
    if (!text) continue;
    const firstLine = text.split("\n")[0].trim();
    if (!firstLine) continue;
    return firstLine.length > 100 ? `${firstLine.substring(0, 97)}...` : firstLine;
  }
  return "Untitled Codex Session";
}

export function transformCodexToHaevnChat(extraction: CodexRawExtraction): Chat {
  const messages: Record<string, ChatMessage> = {};
  const models = new Set<string>(extraction.metadata.models);
  const toolNameByCallId = new Map<string, string>();

  if (extraction.metadata.baseInstructions) {
    const sysId = uuidv4();
    messages[sysId] = {
      id: sysId,
      childrenIds: [],
      message: [
        {
          kind: "request",
          parts: [
            {
              part_kind: "system-prompt",
              content: extraction.metadata.baseInstructions,
              timestamp: new Date(extraction.metadata.createdTimestamp).toISOString(),
              dynamic_ref: "base_instructions",
            },
          ],
        },
      ],
      model: "",
      done: true,
      timestamp: extraction.metadata.createdTimestamp,
      chatId: extraction.sessionId,
    };
  }

  let previousId = Object.keys(messages)[0];

  for (const line of extraction.lines) {
    if (line.type === "turn_context" && line.payload && typeof line.payload.model === "string") {
      if (line.payload.model) {
        models.add(line.payload.model);
      }
    }

    const modelMessage = lineToModelMessage(line, toolNameByCallId);
    if (!modelMessage) continue;

    const id = uuidv4();
    const chatMessage: ChatMessage = {
      id,
      parentId: previousId || undefined,
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
    source: "codex",
    sourceId: extraction.sessionId,
    title: extractTitle(extraction),
    models: Array.from(models),
    params: {
      sessionId: extraction.sessionId,
      cwd: extraction.metadata.cwd,
      originator: extraction.metadata.originator,
      cliVersion: extraction.metadata.cliVersion,
      codexSource: extraction.metadata.source,
      modelProvider: extraction.metadata.modelProvider,
    },
    currentId,
    messages,
    tags: [],
    timestamp: extraction.metadata.createdTimestamp,
    lastSyncedTimestamp: Date.now(),
    providerLastModifiedTimestamp: extraction.metadata.lastModifiedTimestamp,
  };
}
