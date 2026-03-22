// AI Studio to HAEVN.Chat Transformer

import { v4 as uuidv4 } from "uuid";
import type {
  AudioResponsePart,
  Chat,
  DocumentResponsePart,
  HAEVN,
  ImageResponsePart,
  ModelRequest,
  ModelResponse,
  ModelResponsePart,
  TextPart,
  ThinkingPart,
  UserContent,
  UserPromptPart,
  VideoResponsePart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { processExternalAssets, type UrlAsset } from "../../utils/media_utils";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { AIStudioConversationData } from "./model";

export async function transformAIStudioToHaevn(
  aistudioData: AIStudioConversationData,
): Promise<HAEVN.Chat> {
  // Pre-generate message IDs
  const messageIds: string[] = aistudioData.messages.map(() => uuidv4());
  const chatId = aistudioData.conversationId;

  log.info(
    `[AI Studio Transformer] Creating chat with ID: ${chatId}, messageCount: ${aistudioData.messages.length}`,
  );

  // Process files per message to enable OPFS storage with proper chatId/messageId context
  const messageFiles: Map<number, UserContent[]> = new Map();

  for (let i = 0; i < aistudioData.messages.length; i++) {
    const msg = aistudioData.messages[i];
    const messageId = messageIds[i];

    if (!msg.files || msg.files.length === 0) {
      messageFiles.set(i, []);
      continue;
    }

    // Map platform-specific file info to generic UrlAsset
    const assets: UrlAsset[] = msg.files.map((file) => ({
      url: file.url,
      type: file.type,
      name: file.name,
    }));

    log.info(
      `[AI Studio Transformer] Downloading ${assets.length} files for message ${i + 1}/${aistudioData.messages.length}`,
    );

    // Process with chatId and messageId for OPFS storage
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[AI Studio Transformer]",
      supportAllMediaTypes: true, // AI Studio supports all media types
      chatId,
      messageId,
    });

    messageFiles.set(i, downloadedContent);
  }

  log.info(`[AI Studio Transformer] Finished downloading files for all messages`);

  // Convert to TreeNode format with sequential parent relationships
  const treeNodes: TreeNode<{
    aistudioMsg: AIStudioConversationData["messages"][0];
    filesAsUserContent: UserContent[];
    chatId: string;
    modelName: string;
  }>[] = aistudioData.messages.map((aistudioMsg, msgIndex) => {
    // Get downloaded content for this message's files
    const filesAsUserContent = messageFiles.get(msgIndex) || [];

    return {
      id: messageIds[msgIndex],
      parentId: msgIndex > 0 ? messageIds[msgIndex - 1] : undefined,
      data: {
        aistudioMsg,
        filesAsUserContent,
        chatId,
        modelName: aistudioData.modelName || "Gemini",
      },
    };
  });

  // Use shared tree builder utility
  const { messages } = buildMessageTree(treeNodes, (node) => {
    const { aistudioMsg, filesAsUserContent, chatId, modelName } = node.data;

    let modelMessage: ModelRequest | ModelResponse;

    if (aistudioMsg.role === "user") {
      const content: UserContent[] = [aistudioMsg.content, ...filesAsUserContent];
      const userPromptPart: UserPromptPart = {
        part_kind: "user-prompt",
        content: content.length === 1 && typeof content[0] === "string" ? content[0] : content,
        timestamp: aistudioMsg.timestamp,
      };
      const request: ModelRequest = {
        kind: "request",
        parts: [userPromptPart],
      };
      modelMessage = request;
    } else {
      // assistant
      const responseParts: ModelResponsePart[] = [];

      // Add text part if there's content
      if (aistudioMsg.content) {
        const textPart: TextPart = {
          part_kind: "text",
          content: aistudioMsg.content,
        };
        responseParts.push(textPart);
      }

      // Add thinking part if present
      if (aistudioMsg.thinking) {
        const thinkingPart: ThinkingPart = {
          part_kind: "thinking",
          content: aistudioMsg.thinking,
        };
        responseParts.push(thinkingPart);
      }

      // Add media files as response parts
      filesAsUserContent.forEach((file) => {
        if (typeof file === "string") return;

        const mediaType = file.kind === "binary" ? file.media_type : "";
        if (file.kind === "image-url" || mediaType.startsWith("image/")) {
          responseParts.push({
            part_kind: "image-response",
            content: file,
          } as ImageResponsePart);
        } else if (file.kind === "video-url" || mediaType.startsWith("video/")) {
          responseParts.push({
            part_kind: "video-response",
            content: file,
          } as VideoResponsePart);
        } else if (file.kind === "audio-url" || mediaType.startsWith("audio/")) {
          responseParts.push({
            part_kind: "audio-response",
            content: file,
          } as AudioResponsePart);
        } else {
          responseParts.push({
            part_kind: "document-response",
            content: file,
          } as DocumentResponsePart);
        }
      });

      const response: ModelResponse = {
        kind: "response",
        parts: responseParts,
        timestamp: aistudioMsg.timestamp,
        model_name: modelName,
      };
      modelMessage = response;
    }

    return {
      id: node.id,
      parentId: node.parentId,
      childrenIds: [],
      message: [modelMessage],
      model: modelName,
      done: true,
      timestamp: new Date(aistudioMsg.timestamp).getTime(),
      chatId: chatId,
    };
  });

  // Use the last message's timestamp for the chat timestamp
  // If no messages, fall back to extractedAt
  let chatTimestamp: number;
  let providerLastModifiedTimestamp: number;
  if (aistudioData.messages.length > 0) {
    const lastMessage = aistudioData.messages[aistudioData.messages.length - 1];
    chatTimestamp = new Date(lastMessage.timestamp).getTime();
    providerLastModifiedTimestamp = new Date(lastMessage.timestamp).getTime();
    log.info(`[AI Studio Transformer] Setting providerLastModifiedTimestamp from newest message:`, {
      chatId,
      lastMessageTimestamp: lastMessage.timestamp,
      providerLastModifiedTimestamp,
      providerLastModifiedTimestampDate: new Date(providerLastModifiedTimestamp).toISOString(),
      messageCount: aistudioData.messages.length,
    });
  } else {
    chatTimestamp = new Date(aistudioData.extractedAt).getTime();
    providerLastModifiedTimestamp = new Date(aistudioData.extractedAt).getTime();
    log.info(
      `[AI Studio Transformer] No messages, using extractedAt for providerLastModifiedTimestamp:`,
      {
        chatId,
        extractedAt: aistudioData.extractedAt,
        providerLastModifiedTimestamp,
        providerLastModifiedTimestampDate: new Date(providerLastModifiedTimestamp).toISOString(),
      },
    );
  }

  const chat: Chat = {
    id: chatId,
    source: "aistudio",
    sourceId: aistudioData.conversationId,
    title: aistudioData.title,
    models: [aistudioData.modelName || "Gemini"],
    system: aistudioData.systemInstructions,
    params: {},
    currentId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : "",
    messages: messages,
    tags: ["aistudio", aistudioData.modelName || "Gemini"],
    timestamp: chatTimestamp,
    providerLastModifiedTimestamp: providerLastModifiedTimestamp,
  } as Chat;

  return chat;
}
