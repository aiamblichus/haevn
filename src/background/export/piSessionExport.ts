import type {
  Chat,
  ChatMessage,
  DocumentResponsePart,
  ModelRequest,
  ModelResponse,
} from "../../model/haevn_model";

interface PiSessionLine {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

interface PiModelChangeLine {
  type: "model_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  provider?: string;
  modelId?: string;
}

interface PiThinkingLevelChangeLine {
  type: "thinking_level_change";
  id: string;
  parentId: string | null;
  timestamp: string;
  thinkingLevel: string;
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface PiMessageLine {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<Record<string, unknown>>;
    timestamp: number;
    model?: string;
    provider?: string;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    usage?: PiUsage;
    stopReason?: string;
  };
}

function safeIsoFromMs(timestamp: number | undefined): string {
  if (!timestamp) return new Date().toISOString();
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return new Date().toISOString();
  return date.toISOString();
}

function pickMessageIds(chat: Chat, selectedMessageIds?: string[]): string[] {
  if (Array.isArray(selectedMessageIds) && selectedMessageIds.length > 0) {
    return selectedMessageIds.filter((id) => !!chat.messages[id]);
  }

  if (chat.currentId && chat.messages[chat.currentId]) {
    const reversed: string[] = [];
    let current: ChatMessage | undefined = chat.messages[chat.currentId];
    while (current) {
      reversed.push(current.id);
      current = current.parentId ? chat.messages[current.parentId] : undefined;
    }
    return reversed.reverse();
  }

  return Object.values(chat.messages)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    .map((message) => message.id);
}

function makeId(prefix: string, index: number): string {
  return `${prefix}_${String(index).padStart(4, "0")}`;
}

function estimateTokensFromChars(charCount: number): number {
  if (charCount <= 0) return 0;
  return Math.max(1, Math.round(charCount / 4));
}

function estimateContentChars(blocks: Array<Record<string, unknown>>): number {
  let total = 0;
  for (const block of blocks) {
    try {
      total += JSON.stringify(block).length;
    } catch {
      total += 0;
    }
  }
  return total;
}

function buildUsage(inputChars: number, outputChars: number): PiUsage {
  const input = estimateTokensFromChars(inputChars);
  const output = estimateTokensFromChars(outputChars);
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function toUserContentBlocks(message: ChatMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const modelMessage of message.message) {
    if (modelMessage.kind !== "request") continue;

    for (const part of (modelMessage as ModelRequest).parts) {
      if (part.part_kind === "system-prompt") {
        blocks.push({ type: "text", text: `[system] ${part.content}` });
        continue;
      }

      if (part.part_kind === "retry-prompt") {
        blocks.push({
          type: "text",
          text:
            typeof part.content === "string" ? part.content : JSON.stringify(part.content, null, 2),
        });
        continue;
      }

      if (part.part_kind !== "user-prompt") continue;

      if (typeof part.content === "string") {
        blocks.push({ type: "text", text: part.content });
        continue;
      }

      if (!Array.isArray(part.content)) continue;

      for (const item of part.content) {
        if (typeof item === "string") {
          blocks.push({ type: "text", text: item });
          continue;
        }

        if (item.kind === "binary") {
          blocks.push({
            type: "text",
            text: `[binary attachment omitted: ${item.media_type}]`,
          });
          continue;
        }

        if ("url" in item && typeof item.url === "string") {
          if (item.kind === "image-url") {
            blocks.push({ type: "image", url: item.url, mediaType: "image" });
          } else {
            blocks.push({ type: "url", url: item.url });
          }
        }
      }
    }
  }

  return blocks;
}

function toAssistantContentBlocks(message: ChatMessage): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  for (const modelMessage of message.message) {
    if (modelMessage.kind !== "response") continue;

    for (const part of (modelMessage as ModelResponse).parts) {
      if (part.part_kind === "thinking") {
        blocks.push({
          type: "thinking",
          thinking: part.content,
          ...(part.signature ? { thinkingSignature: part.signature } : {}),
          ...(part.id ? { id: part.id } : {}),
        });
        continue;
      }

      if (part.part_kind === "text") {
        blocks.push({ type: "text", text: part.content });
        continue;
      }

      if (part.part_kind === "tool-call") {
        blocks.push({
          type: "toolCall",
          id: part.tool_call_id,
          name: part.tool_name,
          arguments: typeof part.args === "object" ? part.args : { raw: String(part.args || "") },
        });
        continue;
      }

      if (
        part.part_kind === "image-response" ||
        part.part_kind === "video-response" ||
        part.part_kind === "audio-response" ||
        part.part_kind === "document-response"
      ) {
        const mediaPart = part as DocumentResponsePart;
        if (mediaPart.content.kind === "binary") {
          blocks.push({
            type: "text",
            text: `[binary response omitted: ${mediaPart.content.media_type}]`,
          });
        } else if ("url" in mediaPart.content && typeof mediaPart.content.url === "string") {
          if (mediaPart.content.kind === "image-url") {
            blocks.push({ type: "image", url: mediaPart.content.url, mediaType: "image" });
          } else {
            blocks.push({ type: "url", url: mediaPart.content.url });
          }
        }
      }
    }
  }

  return blocks;
}

export function exportChatAsPiSessionJsonl(chat: Chat, selectedMessageIds?: string[]): string {
  const nowIso = new Date().toISOString();
  const lines: Array<
    PiSessionLine | PiModelChangeLine | PiThinkingLevelChangeLine | PiMessageLine
  > = [];

  lines.push({
    type: "session",
    version: 3,
    id: chat.id || chat.sourceId,
    timestamp: safeIsoFromMs(chat.timestamp),
    cwd: typeof chat.params?.cwd === "string" ? (chat.params.cwd as string) : undefined,
  });

  let parentEventId: string | null = null;
  let eventIndex = 1;

  if (chat.models.length > 0) {
    const id = makeId("model", eventIndex++);
    lines.push({
      type: "model_change",
      id,
      parentId: parentEventId,
      timestamp: nowIso,
      provider: chat.source,
      modelId: chat.models[chat.models.length - 1],
    });
    parentEventId = id;
  }

  const thinkingLevel =
    typeof chat.params?.thinkingLevel === "string" ? (chat.params.thinkingLevel as string) : null;
  if (thinkingLevel) {
    const id = makeId("thinking", eventIndex++);
    lines.push({
      type: "thinking_level_change",
      id,
      parentId: parentEventId,
      timestamp: nowIso,
      thinkingLevel,
    });
    parentEventId = id;
  }

  const messageIds = pickMessageIds(chat, selectedMessageIds);
  let pendingInputChars = 0;

  for (const messageId of messageIds) {
    const message = chat.messages[messageId];
    if (!message) continue;

    const hasRequest = message.message.some((modelMessage) => modelMessage.kind === "request");
    const hasResponse = message.message.some((modelMessage) => modelMessage.kind === "response");

    if (hasRequest) {
      const toolReturns = message.message
        .filter((modelMessage) => modelMessage.kind === "request")
        .flatMap((modelMessage) => (modelMessage as ModelRequest).parts)
        .filter((part) => part.part_kind === "tool-return");

      if (toolReturns.length > 0) {
        for (const toolReturn of toolReturns) {
          const id = makeId("msg", eventIndex++);
          const content = [
            {
              type: "text",
              text:
                typeof toolReturn.content === "string"
                  ? toolReturn.content
                  : JSON.stringify(toolReturn.content, null, 2),
            },
          ];

          lines.push({
            type: "message",
            id,
            parentId: parentEventId,
            timestamp: safeIsoFromMs(message.timestamp),
            message: {
              role: "toolResult",
              toolCallId: toolReturn.tool_call_id,
              toolName: toolReturn.tool_name,
              content,
              timestamp: message.timestamp || Date.now(),
              isError: false,
            },
          });
          pendingInputChars += estimateContentChars(content);
          parentEventId = id;
        }
      } else {
        const content = toUserContentBlocks(message);
        if (content.length > 0) {
          const id = makeId("msg", eventIndex++);
          lines.push({
            type: "message",
            id,
            parentId: parentEventId,
            timestamp: safeIsoFromMs(message.timestamp),
            message: {
              role: "user",
              content,
              timestamp: message.timestamp || Date.now(),
            },
          });
          pendingInputChars += estimateContentChars(content);
          parentEventId = id;
        }
      }
    }

    if (hasResponse) {
      const content = toAssistantContentBlocks(message);
      if (content.length > 0) {
        const id = makeId("msg", eventIndex++);
        const outputChars = estimateContentChars(content);
        const usage = buildUsage(pendingInputChars, outputChars);
        lines.push({
          type: "message",
          id,
          parentId: parentEventId,
          timestamp: safeIsoFromMs(message.timestamp),
          message: {
            role: "assistant",
            content,
            provider: chat.source,
            model: message.model || chat.models[chat.models.length - 1],
            timestamp: message.timestamp || Date.now(),
            usage,
            stopReason: "endTurn",
          },
        });
        pendingInputChars = 0;
        parentEventId = id;
      }
    }
  }

  return lines.map((line) => JSON.stringify(line)).join("\n");
}
