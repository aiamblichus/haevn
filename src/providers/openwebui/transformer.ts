import type {
  Chat,
  HAEVN,
  ModelRequest,
  ModelResponse,
  ModelResponsePart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { OpenWebUIMessage, OpenWebUIRawExtraction } from "./model";

function toMs(value?: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value)) return undefined;
  // Open WebUI timestamps can arrive in seconds or milliseconds.
  if (value >= 1_000_000_000_000) return Math.floor(value);
  return Math.floor(value * 1000);
}

function isoNow(): string {
  return new Date().toISOString();
}

function toIsoFromSeconds(value?: number): string {
  const ms = toMs(value);
  if (ms === undefined) return isoNow();
  return new Date(ms).toISOString();
}

function extractThinkingParts(content: string): {
  parts: ThinkingPart[];
  cleaned: string;
} {
  const parts: ThinkingPart[] = [];
  const pattern = /<details\s+type=["']?reasoning["']?[^>]*>([\s\S]*?)<\/details>/gi;
  let cleaned = content;
  let idx = 1;
  let match: RegExpExecArray | null = pattern.exec(content);
  while (match !== null) {
    const innerRaw = (match[1] || "").replace(/<summary[^>]*>[\s\S]*?<\/summary>/gi, "").trim();
    const text = innerRaw.replace(/^>\s*/gm, "").trim();
    if (text)
      parts.push({
        part_kind: "thinking",
        content: text,
        id: `thinking_${idx++}`,
      });
    match = pattern.exec(content);
  }
  cleaned = cleaned.replace(pattern, "").trim();
  return { parts, cleaned };
}

// Use OpenWebUIRawExtraction from model.ts instead of local interface

// Helper function to extract model name from arrays, with fallback
function getModelName(
  messageModels?: string[],
  chatModels?: string[],
  fallback: string = "Open WebUI",
): string {
  // Prefer message-level models, then chat-level, then fallback
  const models = messageModels || chatModels;
  if (models && models.length > 0) {
    return models[0];
  }
  return fallback;
}

export function transformOpenWebUIToHaevn(raw: OpenWebUIRawExtraction): HAEVN.Chat {
  const { chat, folderSystems = [] } = raw;

  log.debug("[OpenWebUI] Transforming chat:", {
    id: chat.id,
    chatSystem: !!chat.system,
    folderSystemsCount: folderSystems.length,
  });

  // Combine chat system prompt and folder system prompts
  // According to instructions: folders outermost to innermost, then chat system prompt last
  const allSystemPrompts = [...folderSystems, chat.system].filter((s): s is string => !!s);
  const effectiveSystem = allSystemPrompts.length > 0 ? allSystemPrompts.join("\n\n") : undefined;

  if (effectiveSystem) {
    log.debug("[OpenWebUI] Effective system prompt created, length:", effectiveSystem.length);
  } else {
    log.debug("[OpenWebUI] No system prompt found (neither chat nor folders)");
  }

  // Extract chat-level models
  const chatModels = chat.chat?.models || [];

  // Collect messages from history.messages if available
  const historyMsgs: { id: string; msg: OpenWebUIMessage }[] = [];
  const map = chat.chat?.history?.messages || {};
  for (const [key, value] of Object.entries(map)) {
    historyMsgs.push({ id: key, msg: value });
  }
  // If nothing in history, we can't build a conversation
  if (historyMsgs.length === 0) {
    // Return empty chat structure
    return {
      id: chat.id,
      source: "openwebui",
      sourceId: chat.id,
      userId: chat.user_id,
      title: chat.title || chat.chat?.title || "Open WebUI Chat",
      models: chatModels.length > 0 ? chatModels : ["Open WebUI"],
      system: undefined,
      params: {},
      currentId: chat.id,
      messages: {},
      tags: ["openwebui"],
      timestamp: toMs(chat.created_at) || Date.now(),
      providerLastModifiedTimestamp: toMs(chat.updated_at),
      lastSyncedTimestamp: Date.now(),
      checksum: "",
      syncStatus: "pending",
    } as Chat;
  }

  // Convert to TreeNode format
  const treeNodes: TreeNode<{
    id: string;
    msg: OpenWebUIMessage;
    chatId: string;
    chatModels: string[];
  }>[] = historyMsgs.map(({ id, msg }) => ({
    id,
    parentId: msg.parentId?.trim() ? msg.parentId : undefined,
    data: {
      id,
      msg,
      chatId: chat.id,
      chatModels,
    },
  }));

  // Use shared tree builder utility
  const { messages } = buildMessageTree(treeNodes, (node) => {
    const { id, msg, chatId, chatModels } = node.data;
    const role = (msg.role || "").toLowerCase();

    // Extract model name for this message (prefer message-level, fallback to chat-level)
    const modelName = getModelName(msg.models, chatModels);

    let modelMessage: ModelRequest | ModelResponse;
    const messageTimestamp = toIsoFromSeconds(msg.timestamp);

    if (role === "user") {
      const up: UserPromptPart = {
        part_kind: "user-prompt",
        content: msg.content || "",
        timestamp: messageTimestamp,
      };
      modelMessage = { kind: "request", parts: [up] } as ModelRequest;
    } else if (role === "system") {
      modelMessage = {
        kind: "request",
        parts: [
          {
            part_kind: "system-prompt",
            content: msg.content || "",
            timestamp: messageTimestamp,
          },
        ],
      } as ModelRequest;
    } else {
      const { parts: reasoning, cleaned } = extractThinkingParts(msg.content || "");
      const respParts: ModelResponsePart[] = [];
      if (reasoning.length) respParts.push(...reasoning);
      if (cleaned) respParts.push({ part_kind: "text", content: cleaned } as TextPart);
      if (respParts.length === 0) respParts.push({ part_kind: "text", content: "" } as TextPart);
      modelMessage = {
        kind: "response",
        parts: respParts,
        timestamp: messageTimestamp,
        model_name: modelName,
      } as ModelResponse;
    }

    return {
      id,
      parentId: node.parentId,
      childrenIds: [],
      message: [modelMessage],
      model: modelName,
      done: true,
      timestamp: toMs(msg.timestamp) || Date.now(),
      chatId: chatId,
    };
  });

  const currentId =
    chat.chat?.history?.currentId ||
    (historyMsgs.length ? historyMsgs[historyMsgs.length - 1].id : chat.id);

  const result: Chat = {
    id: chat.id,
    source: "openwebui",
    sourceId: chat.id,
    userId: chat.user_id,
    title: chat.title || chat.chat?.title || "Open WebUI Chat",
    models: chatModels.length > 0 ? chatModels : ["Open WebUI"],
    system: effectiveSystem,
    params: {},
    currentId,
    messages,
    tags: ["openwebui"],
    timestamp: toMs(chat.created_at) || Date.now(),
    // providerLastModifiedTimestamp is set during save by SyncService, but we can include here too
    providerLastModifiedTimestamp: toMs(chat.updated_at),
    // The following sync fields are filled by SyncService.saveChat
    lastSyncedTimestamp: Date.now(),
    checksum: "",
    syncStatus: "pending",
  };

  return result;
}
