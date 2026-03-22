import { v4 as uuidv4 } from "uuid";
import type {
  Chat,
  ChatMessage,
  CodeExecutionPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelResponsePart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../../model/haevn_model";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { DeepseekApiMessage, DeepseekConversationData, DeepseekMessage } from "./model";

/**
 * Type guard to check if messages are in API format
 */
function isApiMessage(msg: DeepseekApiMessage | DeepseekMessage): msg is DeepseekApiMessage {
  return "message_id" in msg || "fragments" in msg || "thinking_content" in msg;
}

/**
 * Extract content from API message (handles both fragments and direct content formats)
 */
function extractApiMessageContent(msg: DeepseekApiMessage): {
  content: string;
  thinking: string | null;
} {
  // Format 1: Fragments array
  if (msg.fragments && msg.fragments.length > 0) {
    let content = "";
    let thinking: string | null = null;

    for (const fragment of msg.fragments) {
      if (fragment.type === "THINK") {
        thinking = (thinking || "") + fragment.content;
      } else if (fragment.type === "RESPONSE" || fragment.type === "REQUEST") {
        content += fragment.content;
      }
    }

    return { content: content.trim(), thinking: thinking?.trim() || null };
  }

  // Format 2: Direct content fields
  return {
    content: msg.content?.trim() || "",
    thinking: msg.thinking_content?.trim() || null,
  };
}

function buildUserModelMessage(content: string, isoTimestamp: string): ModelRequest {
  const userPromptPart: UserPromptPart = {
    part_kind: "user-prompt",
    content,
    timestamp: isoTimestamp,
  };
  return {
    kind: "request",
    parts: [userPromptPart],
  };
}

function buildAssistantModelMessage(
  msg: DeepseekMessage,
  isoTimestamp: string,
  messageId: string,
): ModelResponse {
  const parts: ModelResponsePart[] = [];

  if (msg.thinking?.trim()) {
    parts.push({
      part_kind: "thinking",
      content: msg.thinking.trim(),
    } as ThinkingPart);
  }

  if (msg.content?.trim()) {
    parts.push({
      part_kind: "text",
      content: msg.content.trim(),
    } as TextPart);
  }

  if (msg.codeBlocks?.length) {
    msg.codeBlocks.forEach((block, idx) => {
      if (!block.code) return;
      const codePart: CodeExecutionPart = {
        part_kind: "code-execution",
        uuid: `${messageId}-code-${idx}`,
        name: block.language || "code",
        code: block.code,
        language: block.language,
      };
      parts.push(codePart);
    });
  }

  return {
    kind: "response",
    parts,
    timestamp: isoTimestamp,
    model_name: "DeepSeek",
  };
}

/**
 * Build assistant model message from API format
 */
function buildAssistantModelMessageFromApi(
  msg: DeepseekApiMessage,
  isoTimestamp: string,
): ModelResponse {
  const parts: ModelResponsePart[] = [];
  const { content, thinking } = extractApiMessageContent(msg);

  if (thinking) {
    parts.push({
      part_kind: "thinking",
      content: thinking,
    } as ThinkingPart);
  }

  if (content) {
    parts.push({
      part_kind: "text",
      content,
    } as TextPart);
  }

  return {
    kind: "response",
    parts,
    timestamp: isoTimestamp,
    model_name: msg.model || "DeepSeek",
  };
}

function buildChatMessage(
  msg: DeepseekMessage,
  messageId: string,
  chatId: string,
  parentId: string | undefined,
  baseTimestamp: number,
  index: number,
): ChatMessage {
  const ts = baseTimestamp + index;
  const isoTimestamp = new Date(ts).toISOString();

  let modelMessages: ModelMessage[];
  if (msg.role === "user") {
    modelMessages = [buildUserModelMessage(msg.content, isoTimestamp)];
  } else {
    modelMessages = [buildAssistantModelMessage(msg, isoTimestamp, messageId)];
  }

  return {
    id: messageId,
    parentId,
    childrenIds: [],
    message: modelMessages,
    model: "DeepSeek",
    done: true,
    timestamp: ts,
    chatId,
  };
}

/**
 * Build chat message from API format
 */
function buildChatMessageFromApi(
  msg: DeepseekApiMessage,
  messageId: string,
  chatId: string,
  parentId: string | undefined,
  timestamp: number,
): ChatMessage {
  const isoTimestamp = new Date(timestamp).toISOString();
  const { content } = extractApiMessageContent(msg);

  let modelMessages: ModelMessage[];
  if (msg.role === "USER") {
    modelMessages = [buildUserModelMessage(content, isoTimestamp)];
  } else {
    modelMessages = [buildAssistantModelMessageFromApi(msg, isoTimestamp)];
  }

  return {
    id: messageId,
    parentId,
    childrenIds: [],
    message: modelMessages,
    model: msg.model || "DeepSeek",
    done: msg.status === "FINISHED",
    timestamp,
    chatId,
  };
}

export async function transformDeepseekToHaevn(data: DeepseekConversationData): Promise<Chat> {
  const baseTimestamp = !Number.isNaN(Date.parse(data.extractedAt))
    ? new Date(data.extractedAt).getTime()
    : Date.now();
  const messageList = Array.isArray(data.messages) ? data.messages : [];

  // Check if we're dealing with API format or DOM format
  const isApiFormat = messageList.length > 0 && isApiMessage(messageList[0]);

  if (isApiFormat) {
    // API format: messages have message_id, parent_id, and real timestamps
    const apiMessages = messageList as DeepseekApiMessage[];

    // Build ID mapping (message_id -> uuid)
    const idMap = new Map<number, string>();
    for (const msg of apiMessages) {
      idMap.set(msg.message_id, uuidv4());
    }

    // Convert to TreeNode format preserving parent relationships from API
    const treeNodes: TreeNode<{
      msg: DeepseekApiMessage;
      messageId: string;
      chatId: string;
      timestamp: number;
    }>[] = apiMessages.map((msg) => {
      const messageId = idMap.get(msg.message_id) || uuidv4();
      const parentId = msg.parent_id !== null ? idMap.get(msg.parent_id) : undefined;
      // API timestamps are in seconds with decimals
      const timestamp = msg.inserted_at ? Math.floor(msg.inserted_at * 1000) : baseTimestamp;

      return {
        id: messageId,
        parentId,
        data: {
          msg,
          messageId,
          chatId: data.sourceId,
          timestamp,
        },
      };
    });

    // Use shared tree builder utility
    const { messages } = buildMessageTree(treeNodes, (node) => {
      return buildChatMessageFromApi(
        node.data.msg,
        node.data.messageId,
        node.data.chatId,
        node.parentId,
        node.data.timestamp,
      );
    });

    // Get current message ID from session or last message
    let currentId = "";
    if (data.session?.current_message_id) {
      currentId = idMap.get(data.session.current_message_id) || "";
    }
    if (!currentId && apiMessages.length > 0) {
      currentId = idMap.get(apiMessages[apiMessages.length - 1].message_id) || "";
    }

    // Get timestamp from session if available
    const chatTimestamp = data.session?.updated_at
      ? Math.floor(data.session.updated_at * 1000)
      : baseTimestamp;

    // Collect unique model names
    const modelSet = new Set<string>();
    for (const msg of apiMessages) {
      if (msg.model) modelSet.add(msg.model);
    }
    const models = modelSet.size > 0 ? Array.from(modelSet) : ["DeepSeek"];

    const chat: Chat = {
      id: data.sourceId,
      source: "deepseek",
      sourceId: data.sourceId,
      title: data.title || "DeepSeek Chat",
      models,
      system: "",
      params: {
        sourceUrl: data.url,
      },
      currentId: currentId || data.sourceId,
      messages,
      tags: [],
      timestamp: chatTimestamp,
    } as Chat;

    return chat;
  }

  // DOM format: legacy messages with sequential parent relationships
  const domMessages = messageList as DeepseekMessage[];

  // Create unique IDs for each message
  const messageIds: string[] = domMessages.map(() => uuidv4());

  // Convert to TreeNode format with sequential parent relationships
  const treeNodes: TreeNode<{
    msg: DeepseekMessage;
    messageId: string;
    chatId: string;
    baseTimestamp: number;
    index: number;
  }>[] = domMessages.map((msg, idx) => ({
    id: messageIds[idx],
    parentId: idx > 0 ? messageIds[idx - 1] : undefined,
    data: {
      msg,
      messageId: messageIds[idx],
      chatId: data.sourceId,
      baseTimestamp,
      index: idx,
    },
  }));

  // Use shared tree builder utility
  const { messages } = buildMessageTree(treeNodes, (node) => {
    return buildChatMessage(
      node.data.msg,
      node.data.messageId,
      node.data.chatId,
      node.parentId,
      node.data.baseTimestamp,
      node.data.index,
    );
  });

  const currentId = domMessages.length > 0 ? messageIds[messageIds.length - 1] : "";

  const chatTimestamp = baseTimestamp;

  const chat: Chat = {
    id: data.sourceId,
    source: "deepseek",
    sourceId: data.sourceId,
    title: data.title || "DeepSeek Chat",
    models: ["DeepSeek"],
    system: "",
    params: {
      sourceUrl: data.url,
    },
    currentId: currentId || data.sourceId,
    messages,
    tags: [],
    timestamp: chatTimestamp,
  } as Chat; // Sync metadata is populated by SyncService

  return chat;
}
