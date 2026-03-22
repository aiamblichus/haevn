import { v4 as uuidv4 } from "uuid";
import type {
  BinaryContent,
  Chat,
  ChatMessage,
  HAEVN,
  ImageResponsePart,
  ImageUrl,
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
import type { QwenChatData, QwenContentListItem, QwenFile, QwenMessage } from "./model";

/**
 * Extract reasoning content from message content or reasoning_content field
 */
function extractReasoningContent(message: QwenMessage): string | null {
  if (message.reasoning_content) {
    return message.reasoning_content;
  }

  // Check for <think> tags in content
  const content = message.content || "";
  const reasoningMatch = content.match(/<think>([\s\S]*?)<\/redacted_reasoning>/);
  if (reasoningMatch) {
    return reasoningMatch[1].trim();
  }

  // Check for <think> tags (alternative format)
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
  if (thinkMatch) {
    return thinkMatch[1].trim();
  }

  return null;
}

/**
 * Convert Qwen files to HAEVN content types
 */
function convertQwenFiles(files: QwenFile[] | undefined): UrlAsset[] {
  if (!files || files.length === 0) {
    return [];
  }

  return files.map((file) => ({
    url: file.url,
    type: file.file_type,
    name: file.name,
  }));
}

/**
 * Convert Qwen content_list items to HAEVN response parts
 */
function convertContentListItems(
  contentList: QwenContentListItem[] | null | undefined,
  reasoningContent: string | null,
  downloadedContent: UserContent[],
): (TextPart | ThinkingPart | ImageResponsePart)[] {
  const parts: (TextPart | ThinkingPart | ImageResponsePart)[] = [];

  // Add reasoning content first if available
  if (reasoningContent) {
    parts.push({
      part_kind: "thinking",
      content: reasoningContent,
    } as ThinkingPart);
  }

  if (!contentList || contentList.length === 0) {
    return parts;
  }

  let assetIndex = 0;
  for (const item of contentList) {
    switch (item.phase) {
      case "think":
        // Thinking phase
        if (item.content) {
          parts.push({
            part_kind: "thinking",
            content: item.content,
          } as ThinkingPart);
        }
        break;

      case "image_gen":
        // Image generation - extract image URL
        if (item.content && typeof item.content === "string" && item.content.startsWith("http")) {
          // Find the corresponding downloaded content if available
          const content = downloadedContent[assetIndex++];
          if (content) {
            parts.push({
              part_kind: "image-response",
              content: content as ImageUrl | BinaryContent,
            } as ImageResponsePart);
          }
        }
        break;

      case "answer":
        // Answer text
        if (item.content) {
          parts.push({
            part_kind: "text",
            content: item.content,
          } as TextPart);
        }
        break;

      case "web_search":
        // Web search - extract search results and answer
        if (item.extra?.web_search_info) {
          const searchResults = item.extra.web_search_info
            .map((result) => `- [${result.title}](${result.url})\n  ${result.snippet}`)
            .join("\n\n");

          parts.push({
            part_kind: "text",
            content: `## Web Search Results\n\n${searchResults}\n\n${item.content || ""}`,
          } as TextPart);
        } else if (item.content) {
          parts.push({
            part_kind: "text",
            content: item.content,
          } as TextPart);
        }
        break;

      default:
        // Unknown phase - treat as text
        if (item.content) {
          parts.push({
            part_kind: "text",
            content: item.content,
          } as TextPart);
        }
        break;
    }
  }

  return parts;
}

/**
 * Convert Qwen message to HAEVN ChatMessage
 */
function convertQwenMessage(
  qwenMsg: QwenMessage,
  chatId: string,
  downloadedContent: UserContent[],
): ChatMessage {
  const reasoningContent = extractReasoningContent(qwenMsg);

  let modelMessage: ModelRequest | ModelResponse;

  if (qwenMsg.role === "user") {
    // User message
    const content = qwenMsg.content || "";

    const userPromptPart: UserPromptPart = {
      part_kind: "user-prompt",
      content: downloadedContent.length > 0 ? [content, ...downloadedContent] : content,
      timestamp: new Date(qwenMsg.timestamp * 1000).toISOString(),
    };

    modelMessage = {
      kind: "request",
      parts: [userPromptPart],
    } as ModelRequest;
  } else {
    // Assistant message
    const contentParts = convertContentListItems(
      qwenMsg.content_list,
      reasoningContent,
      downloadedContent,
    );

    // If no content_list but there's content, add it as text
    // Note: We check content_list, not contentParts.length, because contentParts
    // may already have a ThinkingPart from reasoningContent extraction
    if ((!qwenMsg.content_list || qwenMsg.content_list.length === 0) && qwenMsg.content) {
      // Remove reasoning tags if present
      let cleanContent = qwenMsg.content;
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/redacted_reasoning>/g, "");
      cleanContent = cleanContent.replace(/<think>[\s\S]*?<\/think>/g, "");
      cleanContent = cleanContent.trim();

      if (cleanContent) {
        contentParts.push({
          part_kind: "text",
          content: cleanContent,
        } as TextPart);
      }
    }

    modelMessage = {
      kind: "response",
      parts: contentParts,
      timestamp: new Date(qwenMsg.timestamp * 1000).toISOString(),
      model_name: qwenMsg.modelName || qwenMsg.model || "Qwen",
      vendor_id: qwenMsg.id,
      usage: qwenMsg.info?.usage,
    } as ModelResponse;
  }

  return {
    id: qwenMsg.id,
    parentId: qwenMsg.parentId || undefined,
    childrenIds: [],
    message: [modelMessage],
    model: qwenMsg.modelName || qwenMsg.model || "Qwen",
    done: qwenMsg.done !== false, // Default to true if not specified
    timestamp: qwenMsg.timestamp * 1000, // Convert seconds to milliseconds
    chatId: chatId,
    info: qwenMsg.info
      ? {
          openai: qwenMsg.info.openai,
          input_tokens: qwenMsg.info.input_tokens,
          completion_tokens: qwenMsg.info.output_tokens,
          total_tokens: qwenMsg.info.total_tokens,
        }
      : undefined,
  };
}

/**
 * Convert Qwen chat data to HAEVN.Chat format
 */
export async function transformQwenToHaevn(
  chatData: QwenChatData,
  tabId?: number,
): Promise<HAEVN.Chat> {
  const conversationId = chatData.id;

  // Process all messages from history.messages
  const historyMessages = Object.values(chatData.chat.history.messages);

  // Collect and download assets per message to maintain proper context
  const messageAssetsMap: Map<string, UserContent[]> = new Map();

  for (let i = 0; i < historyMessages.length; i++) {
    const qwenMsg = historyMessages[i];
    const assets: UrlAsset[] = [];

    // Collect files
    if (qwenMsg.files && qwenMsg.files.length > 0) {
      assets.push(...convertQwenFiles(qwenMsg.files));
    }

    // Collect generated images from content_list
    if (qwenMsg.content_list && qwenMsg.content_list.length > 0) {
      for (const item of qwenMsg.content_list) {
        if (
          item.phase === "image_gen" &&
          item.content &&
          typeof item.content === "string" &&
          item.content.startsWith("http")
        ) {
          assets.push({
            url: item.content,
            type: "image/png", // Qwen typically generates PNGs
          });
        }
      }
    }

    if (assets.length > 0) {
      log.info(
        `[Qwen Transformer] Downloading ${assets.length} assets for message ${i + 1}/${historyMessages.length}`,
      );

      // Process assets with Qwen-specific limits:
      // - concurrency: 2 (as requested, load fewer in parallel)
      // - timeouts: increased to 20s/30s (as requested, images take time)
      // - credentials: "omit" (Qwen images use signed URLs, cookies cause CORS issues)
      // - tabId: delegate fetch to content script if available
      const downloadedContent = await processExternalAssets(assets, {
        logPrefix: "[Qwen Transformer]",
        chatId: conversationId,
        messageId: qwenMsg.id,
        concurrency: 2,
        timeoutMs: 20000,
        overallTimeoutMs: 30000,
        credentials: "omit",
        tabId,
      });

      messageAssetsMap.set(qwenMsg.id, downloadedContent);
    } else {
      messageAssetsMap.set(qwenMsg.id, []);
    }
  }

  // Convert to TreeNode format
  const treeNodes: TreeNode<{
    qwenMsg: QwenMessage;
    chatId: string;
    downloadedContent: UserContent[];
  }>[] = historyMessages.map((qwenMsg) => ({
    id: qwenMsg.id,
    parentId: qwenMsg.parentId || undefined,
    data: {
      qwenMsg,
      chatId: conversationId,
      downloadedContent: messageAssetsMap.get(qwenMsg.id) || [],
    },
  }));

  // Use shared tree builder utility
  const { messages } = buildMessageTree(treeNodes, (node) => {
    return convertQwenMessage(node.data.qwenMsg, node.data.chatId, node.data.downloadedContent);
  });

  // Extract tags from meta if available
  const tags: string[] = [];
  if (chatData.meta?.tags && Array.isArray(chatData.meta.tags)) {
    tags.push(...chatData.meta.tags);
  }

  // Add chat type as a tag
  if (chatData.chat_type) {
    tags.push(`chat_type:${chatData.chat_type}`);
  }

  const chat: HAEVN.Chat = {
    id: conversationId,
    source: "qwen",
    sourceId: conversationId,
    title: chatData.title,
    models: chatData.chat.models || [chatData.chat_type === "t2i" ? "Qwen3-Max" : "Qwen"],
    system: "",
    params: {},
    currentId: chatData.chat.history.currentId || chatData.currentId || "",
    messages: messages,
    tags: tags,
    timestamp: chatData.created_at * 1000, // Convert seconds to milliseconds
    providerLastModifiedTimestamp: chatData.updated_at * 1000, // Convert seconds to milliseconds
    lastSyncedTimestamp: Date.now(),
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
  };

  return chat;
}
