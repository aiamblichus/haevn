import type {
  HAEVN,
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
import type { GrokFileAttachment, GrokRawExtraction, GrokResponse } from "./model";

const GROK_ASSETS_BASE_URL = "https://assets.grok.com";

/**
 * Convert Grok file attachments to UrlAsset format for downloading.
 * File URI format: users/{userId}/{fileMetadataId}/content
 * Download URL: https://assets.grok.com/{fileUri}
 */
function convertFileAttachmentsToUrlAssets(attachments: GrokFileAttachment[]): UrlAsset[] {
  return attachments.map((attachment) => {
    // Assets are hosted on assets.grok.com, fileUri contains the full path
    const url = `${GROK_ASSETS_BASE_URL}/${attachment.fileUri}`;

    return {
      url,
      type: attachment.fileMimeType,
      name: attachment.fileName,
    } as UrlAsset;
  });
}

/**
 * Calculate thinking duration in seconds
 */
function calculateThinkingDuration(startTime?: string, endTime?: string): number | undefined {
  if (!startTime || !endTime) return undefined;

  try {
    const start = new Date(startTime).getTime();
    const end = new Date(endTime).getTime();
    return Math.max(0, (end - start) / 1000); // Convert to seconds
  } catch (error) {
    log.warn("[Grok Transformer] Failed to calculate thinking duration:", error);
    return undefined;
  }
}

/**
 * Convert a Grok raw extraction to HAEVN format
 */
export async function convertGrokToHaevn(extraction: GrokRawExtraction): Promise<HAEVN.Chat> {
  const { conversation, responseNodes, responses } = extraction;
  const chatId = conversation.conversationId;

  log.info("[Grok Transformer] Starting transformation", {
    chatId,
    messageCount: responses.length,
  });

  // Step 1: Download all file attachments per message for OPFS storage
  const messageMedia: Map<string, UserContent[]> = new Map();

  for (const response of responses) {
    const messageId = response.responseId;

    if (!response.fileAttachmentsMetadata || response.fileAttachmentsMetadata.length === 0) {
      messageMedia.set(messageId, []);
      continue;
    }

    // Convert to generic UrlAsset format for the shared utility
    const assets = convertFileAttachmentsToUrlAssets(response.fileAttachmentsMetadata);

    log.info(
      `[Grok Transformer] Downloading ${assets.length} attachment(s) for message ${messageId}`,
    );

    // Process with chatId and messageId for OPFS storage
    // Include credentials for authenticated requests
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[Grok Transformer]",
      supportAllMediaTypes: true,
      chatId,
      messageId,
      credentials: "include",
    });

    messageMedia.set(messageId, downloadedContent);
  }

  log.info("[Grok Transformer] Finished downloading all media");

  // Step 2: Create a map of responseId to full response data for easy lookup
  const responseMap = new Map<string, GrokResponse>();
  for (const response of responses) {
    responseMap.set(response.responseId, response);
  }

  // Step 3: Convert Grok responses to TreeNode format
  const nodes: TreeNode<{
    response: GrokResponse;
    conversationId: string;
    downloadedMedia: UserContent[];
  }>[] = responseNodes.map((node) => {
    const response = responseMap.get(node.responseId);
    if (!response) {
      throw new Error(`Response not found for node ${node.responseId}`);
    }

    return {
      id: node.responseId,
      parentId: node.parentResponseId,
      data: {
        response,
        conversationId: conversation.conversationId,
        downloadedMedia: messageMedia.get(node.responseId) || [],
      },
    };
  });

  // Step 4: Build message tree
  const { messages } = buildMessageTree(nodes, (node) => {
    const { response, conversationId, downloadedMedia } = node.data;

    // Get model name from response metadata
    const modelName =
      response.model ||
      response.metadata?.requestModelDetails?.modelId ||
      response.requestMetadata?.model ||
      "Grok";

    const timestamp = new Date(response.createTime).getTime();

    if (response.sender === "human") {
      // User message
      const userPromptPart: UserPromptPart = {
        part_kind: "user-prompt",
        content: response.message || "",
        timestamp: response.createTime,
      };

      // Add downloaded media (attachments)
      if (downloadedMedia.length > 0) {
        if (typeof userPromptPart.content === "string") {
          userPromptPart.content = [userPromptPart.content, ...downloadedMedia];
        } else {
          userPromptPart.content.push(...downloadedMedia);
        }
      }

      return {
        id: node.id,
        parentId: node.parentId,
        childrenIds: [],
        message: [
          {
            kind: "request",
            parts: [userPromptPart],
          } as ModelRequest,
        ],
        model: modelName,
        done: true,
        timestamp,
        chatId: conversationId,
      };
    } else {
      // Assistant message
      const parts: (TextPart | ThinkingPart)[] = [];

      // Add thinking block if present
      if (response.thinkingStartTime && response.thinkingEndTime) {
        // Thinking content is not provided in the response
        // We'll add a placeholder indicating thinking occurred
        const duration = calculateThinkingDuration(
          response.thinkingStartTime,
          response.thinkingEndTime,
        );

        parts.push({
          part_kind: "thinking",
          content: `[Thinking for ${duration?.toFixed(1) || "unknown"} seconds]`,
        } as ThinkingPart);
      }

      // Add text content
      if (response.message) {
        parts.push({
          part_kind: "text",
          content: response.message,
        } as TextPart);
      }

      return {
        id: node.id,
        parentId: node.parentId,
        childrenIds: [],
        message: [
          {
            kind: "response",
            parts,
            timestamp: response.createTime,
            model_name: modelName,
            vendor_id: response.responseId,
          } as ModelResponse,
        ],
        model: modelName,
        done: !response.partial,
        timestamp,
        chatId: conversationId,
      };
    }
  });

  // Step 5: Assemble the final Chat object
  const chat: HAEVN.Chat = {
    id: conversation.conversationId,
    source: "grok",
    sourceId: conversation.conversationId,
    title: conversation.title,
    models: ["Grok"], // Could be multiple models, but we'll use generic "Grok"
    system: conversation.systemPromptName || "",
    params: {},
    currentId: responseNodes.length > 0 ? responseNodes[responseNodes.length - 1].responseId : "",
    messages,
    tags: conversation.starred ? ["starred"] : [],
    timestamp: new Date(conversation.createTime).getTime(),
    providerLastModifiedTimestamp: new Date(conversation.modifyTime).getTime(),
  };

  log.info("[Grok Transformer] Chat created", {
    id: chat.id,
    messageCount: Object.keys(messages).length,
  });

  return chat;
}
