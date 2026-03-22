// src/providers/gemini/transformer.ts

import { v4 as uuidv4 } from "uuid";
import type {
  HAEVN,
  ImageResponsePart,
  ModelRequest,
  ModelResponse,
  TextPart,
  ThinkingPart,
  UserContent,
  UserPromptPart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { processExternalAssets, type UrlAsset } from "../../utils/media_utils";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { GeminiConversationData } from "./model";

export async function transformGeminiToHaevn(
  geminiData: GeminiConversationData,
  tabId?: number,
): Promise<HAEVN.Chat> {
  // IDs are already normalized (no 'c_' prefix) when extracted from URL
  const conversationId = geminiData.conversationId;

  // Create a unique ID for each message
  const messageIds: string[] = geminiData.messages.map(() => uuidv4());

  // Process files per message to enable OPFS storage with proper chatId/messageId context
  const messageFiles: Map<number, UserContent[]> = new Map();

  for (let i = 0; i < geminiData.messages.length; i++) {
    const msg = geminiData.messages[i];
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
      `[Gemini Transformer] Downloading ${assets.length} files for message ${i + 1}/${geminiData.messages.length}`,
    );

    // Process with chatId and messageId for OPFS storage
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[Gemini Transformer]",
      supportAllMediaTypes: false, // Gemini only supports images
      chatId: conversationId,
      messageId,
      tabId,
      helperTabOnly: true,
    });

    messageFiles.set(i, downloadedContent);
  }

  log.info(`[Gemini Transformer] Finished downloading files for all messages`);

  // Convert to TreeNode format with sequential parent relationships
  const treeNodes: TreeNode<{
    geminiMsg: GeminiConversationData["messages"][0];
    filesAsUserContent: UserContent[];
    conversationId: string;
  }>[] = geminiData.messages.map((geminiMsg, index) => {
    // Get downloaded content for this message's files
    const filesAsUserContent = messageFiles.get(index) || [];

    return {
      id: messageIds[index],
      parentId: index > 0 ? messageIds[index - 1] : undefined,
      data: {
        geminiMsg,
        filesAsUserContent,
        conversationId,
      },
    };
  });

  // Use shared tree builder utility
  const { messages } = buildMessageTree(treeNodes, (node) => {
    const { geminiMsg, filesAsUserContent, conversationId } = node.data;

    let modelMessage: ModelRequest | ModelResponse;
    if (geminiMsg.role === "user") {
      // Combine text and images into UserContent array
      const userContent: UserContent[] = [];
      if (geminiMsg.content) {
        userContent.push(geminiMsg.content);
      }
      userContent.push(...filesAsUserContent);

      const userPromptPart: UserPromptPart = {
        part_kind: "user-prompt",
        content:
          userContent.length === 1 && typeof userContent[0] === "string"
            ? userContent[0]
            : userContent,
        timestamp: geminiMsg.timestamp,
      };
      const request: ModelRequest = {
        kind: "request",
        parts: [userPromptPart],
      };
      modelMessage = request;
    } else {
      // assistant
      const responseParts: (TextPart | ThinkingPart | ImageResponsePart)[] = [];

      // Add thinking part first if present
      if (geminiMsg.thinking) {
        const thinkingPart: ThinkingPart = {
          part_kind: "thinking",
          content: geminiMsg.thinking,
        };
        responseParts.push(thinkingPart);
      }

      // Add text part
      const textPart: TextPart = {
        part_kind: "text",
        content: geminiMsg.content,
      };
      responseParts.push(textPart);

      // Add image parts for each file (following Poe's pattern)
      filesAsUserContent.forEach((file) => {
        if (typeof file === "string") return;

        const mediaType = file.kind === "binary" ? file.media_type : "";
        if (file.kind === "image-url" || mediaType.startsWith("image/")) {
          responseParts.push({
            part_kind: "image-response",
            content: file,
          } as ImageResponsePart);
        }
      });

      const response: ModelResponse = {
        kind: "response",
        parts: responseParts,
        timestamp: geminiMsg.timestamp,
        model_name: "gemini",
      };
      modelMessage = response;
    }

    return {
      id: node.id,
      parentId: node.parentId,
      childrenIds: [],
      message: [modelMessage],
      model: "gemini",
      done: true,
      // Milliseconds since epoch
      timestamp: new Date(geminiMsg.timestamp).getTime(),
      chatId: conversationId,
    };
  });

  const chat: HAEVN.Chat = {
    id: conversationId,
    source: "gemini",
    sourceId: conversationId,
    title: geminiData.title,
    models: ["gemini"],
    params: {},
    currentId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : "",
    messages: messages,
    tags: [],
    // Milliseconds since epoch
    timestamp: new Date(geminiData.extractedAt).getTime(),
    providerLastModifiedTimestamp:
      geminiData.messages.length > 0
        ? Math.max(...geminiData.messages.map((m) => new Date(m.timestamp).getTime()))
        : new Date(geminiData.extractedAt).getTime(),
    // Sync metadata fields - will be set by SyncService.saveChat()
    lastSyncedTimestamp: Date.now(),
    checksum: "",
    syncStatus: "new",
    deleted: 0, // Active chat (not soft-deleted)
  };

  return chat;
}
