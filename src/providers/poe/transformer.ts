/**
 * Poe to HAEVN Transformer
 * Converts Poe GraphQL API responses to HAEVN.Chat format
 */

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
  UserContent,
  UserPromptPart,
  VideoResponsePart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { processExternalAssets, type UrlAsset } from "../../utils/media_utils";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { Attachment, Message, PoeConversationData } from "./model";

// ============================================================================
// Main Transform Function
// ============================================================================

export async function transformPoeToHaevn(poeData: PoeConversationData): Promise<HAEVN.Chat[]> {
  log.info("[Poe Transformer] Starting transformation", {
    chatCode: poeData.chatCode,
    messageCount: poeData.messages.length,
  });

  const chat = await createChat(poeData);
  return [chat];
}

// ============================================================================
// Chat Creation
// ============================================================================

async function createChat(poeData: PoeConversationData): Promise<Chat> {
  // Identify which message indices should be new roots (after chat breaks)
  // and filter out the chat_break messages themselves
  const newRootIndices = new Set<number>();
  newRootIndices.add(0); // First message is always a root

  const sorted = poeData.messages.sort((a, b) => a.creationTime - b.creationTime);

  const realMessages: Message[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    if (msg.author === "chat_break") {
      // Next real message becomes a new root
      newRootIndices.add(realMessages.length);
    } else {
      realMessages.push(msg);
    }
  }

  log.info(`[Poe Transformer] Processing messages`, {
    total: poeData.messages.length,
    realMessages: realMessages.length,
    roots: newRootIndices.size,
  });

  // Generate unique IDs for each real message
  const messageIds = realMessages.map(() => uuidv4());
  const chatId = poeData.chatCode;

  // Process attachments per message to enable OPFS storage with proper chatId/messageId context
  // This is slightly slower than batch download but enables proper media storage
  // We track inline attachments separately so we can strip their markdown references from text
  const messageAttachments: Map<number, { content: UserContent[]; inlineUrls: string[] }> =
    new Map();

  for (let i = 0; i < realMessages.length; i++) {
    const msg = realMessages[i];
    const messageId = messageIds[i];

    if (msg.attachments.length === 0) {
      messageAttachments.set(i, { content: [], inlineUrls: [] });
      continue;
    }

    // Collect inline attachment URLs for assistant messages (to strip from text later)
    // We collect BOTH att.url AND att.file.url because the markdown might reference either.
    // Poe's image generation bots often embed the file.url in the markdown text.
    const isAssistant = msg.author !== "human";
    const inlineUrls: string[] = [];
    if (isAssistant) {
      for (const att of msg.attachments) {
        if (att.isInline) {
          if (att.url) inlineUrls.push(att.url);
          if (att.file?.url && att.file.url !== att.url) inlineUrls.push(att.file.url);
        }
      }
    }

    // Debug: log attachment URLs vs what's in the message text
    if (isAssistant && msg.attachments.length > 0) {
      log.debug(`[Poe Transformer] Attachment debug for message ${i}:`, {
        textPreview: msg.text.substring(0, 300),
        attachments: msg.attachments.map((att) => ({
          isInline: att.isInline,
          url: att.url,
          fileUrl: att.file?.url,
        })),
        collectedInlineUrls: inlineUrls,
      });
    }

    // Map to generic UrlAsset format for the shared utility
    // Use att.url if available, otherwise fall back to att.file.url
    const assets: UrlAsset[] = msg.attachments
      .filter((att) => Boolean(att.url || att.file?.url))
      .map((att) => ({
        url: att.url || att.file.url,
        type: att.file.mimeType,
        name: att.name,
      }));

    log.info(
      `[Poe Transformer] Downloading ${assets.length} attachments for message ${i + 1}/${realMessages.length}`,
    );

    // Process with chatId and messageId for OPFS storage
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[Poe Transformer]",
      supportAllMediaTypes: true,
      chatId,
      messageId,
    });

    messageAttachments.set(i, { content: downloadedContent, inlineUrls });
  }

  log.info(`[Poe Transformer] Finished downloading attachments for all messages`);

  // Build tree nodes with proper parent relationships
  // Messages at newRootIndices become roots (no parent)
  const treeNodes: TreeNode<{
    message: Message;
    attachmentContent: UserContent[];
    inlineUrls: string[];
  }>[] = realMessages.map((message, index) => {
    // Get downloaded content for this message's attachments
    const attachmentData = messageAttachments.get(index) || {
      content: [],
      inlineUrls: [],
    };

    // Messages at newRootIndices become roots (no parent)
    const isNewRoot = newRootIndices.has(index);

    return {
      id: messageIds[index],
      parentId: isNewRoot ? undefined : messageIds[index - 1],
      data: {
        message,
        attachmentContent: attachmentData.content,
        inlineUrls: attachmentData.inlineUrls,
      },
    };
  });

  // Build message tree
  const { messages: haevnMessages } = buildMessageTree(treeNodes, (node) => {
    const { message, attachmentContent, inlineUrls } = node.data;
    const isUser = message.author === "human";
    const botName = message.bot?.displayName || poeData.botName;

    let modelMessage: ModelRequest | ModelResponse;

    if (isUser) {
      modelMessage = createUserMessage(message, attachmentContent);
    } else {
      modelMessage = createAssistantMessage(message, attachmentContent, botName, inlineUrls);
    }

    return {
      id: node.id,
      parentId: node.parentId,
      childrenIds: [],
      message: [modelMessage],
      model: botName,
      system: poeData.systemPrompt || "",
      done: true,
      timestamp: microsecondsToMilliseconds(message.creationTime),
      chatId: poeData.chatCode,
    };
  });

  // Get timestamp from last real message
  const lastMessage = realMessages[realMessages.length - 1];
  const chatTimestamp = lastMessage
    ? microsecondsToMilliseconds(lastMessage.creationTime)
    : Date.now();

  const chat: Chat = {
    id: poeData.chatCode,
    source: "poe",
    sourceId: poeData.chatCode,
    title: poeData.title,
    models: [poeData.botName],
    params: {},
    currentId: messageIds.length > 0 ? messageIds[messageIds.length - 1] : "",
    messages: haevnMessages,
    tags: ["poe", poeData.botName],
    system: poeData.systemPrompt || "",
    timestamp: chatTimestamp,
    providerLastModifiedTimestamp: chatTimestamp,
  } as Chat;

  log.info("[Poe Transformer] Chat created", {
    id: chat.id,
    messageCount: haevnMessages.length,
  });

  return chat;
}

// ============================================================================
// Message Creation
// ============================================================================

function createUserMessage(message: Message, attachmentContent: UserContent[]): ModelRequest {
  const content: UserContent[] = [message.text, ...attachmentContent];

  const userPromptPart: UserPromptPart = {
    part_kind: "user-prompt",
    content: content.length === 1 && typeof content[0] === "string" ? content[0] : content,
    timestamp: microsecondsToISOString(message.creationTime),
  };

  return {
    kind: "request",
    parts: [userPromptPart],
  };
}

function createAssistantMessage(
  message: Message,
  attachmentContent: UserContent[],
  botName: string,
  inlineUrls: string[],
): ModelResponse {
  const parts: ModelResponsePart[] = [];

  // Add text content, stripping inline image markdown references
  if (message.text) {
    const cleanedText = stripInlineImageMarkdown(message.text, inlineUrls);
    if (cleanedText.trim()) {
      parts.push({
        part_kind: "text",
        content: cleanedText,
      } as TextPart);
    }
  }

  // Add media attachments
  for (const content of attachmentContent) {
    if (typeof content === "string") continue;

    const mimeType = content.kind === "binary" ? content.media_type : "";

    if (content.kind === "image-url" || mimeType.startsWith("image/")) {
      parts.push({
        part_kind: "image-response",
        content,
      } as ImageResponsePart);
    } else if (content.kind === "video-url" || mimeType.startsWith("video/")) {
      parts.push({
        part_kind: "video-response",
        content,
      } as VideoResponsePart);
    } else if (content.kind === "audio-url" || mimeType.startsWith("audio/")) {
      parts.push({
        part_kind: "audio-response",
        content,
      } as AudioResponsePart);
    } else {
      parts.push({
        part_kind: "document-response",
        content,
      } as DocumentResponsePart);
    }
  }

  return {
    kind: "response",
    parts,
    timestamp: microsecondsToISOString(message.creationTime),
    model_name: botName,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Strip inline image markdown references from text.
 * Poe may use two markdown patterns for inline images:
 *
 * 1. Reference-style:
 *    [refId]: https://...image-url...
 *    ![alt text][refId]
 *
 * 2. Direct inline:
 *    ![alt text](https://...image-url...)
 *
 * We strip both patterns for inline images that we've downloaded to OPFS.
 */
function stripInlineImageMarkdown(text: string, inlineUrls: string[]): string {
  if (inlineUrls.length === 0) return text;

  let result = text;

  for (const url of inlineUrls) {
    // Escape URL for use in regex (URLs contain many special chars)
    const escapedUrl = escapeRegExp(url);

    // Pattern 1: Direct inline markdown - ![any alt](url)
    const directPattern = new RegExp(`!\\[[^\\]]*\\]\\(${escapedUrl}\\)`, "g");
    result = result.replace(directPattern, "");

    // Pattern 2: Reference-style markdown
    // First, find reference definitions containing this URL: [refId]: url
    const refDefPattern = new RegExp(`^\\[([^\\]]+)\\]:\\s*${escapedUrl}\\s*$`, "gm");

    // We need to find all ref IDs that point to this URL
    let refMatch: RegExpExecArray | null;
    const refIds: string[] = [];
    // Reset lastIndex before starting
    refDefPattern.lastIndex = 0;
    while ((refMatch = refDefPattern.exec(result)) !== null) {
      refIds.push(refMatch[1]);
    }

    // Remove reference definitions
    result = result.replace(refDefPattern, "");

    // Remove image usages for each refId: ![any alt][refId]
    for (const refId of refIds) {
      const usagePattern = new RegExp(`!\\[[^\\]]*\\]\\[${escapeRegExp(refId)}\\]`, "g");
      result = result.replace(usagePattern, "");
    }
  }

  // Clean up multiple consecutive blank lines
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert microseconds timestamp to milliseconds
 */
function microsecondsToMilliseconds(microseconds: number): number {
  return Math.floor(microseconds / 1000);
}

/**
 * Convert microseconds timestamp to ISO string
 */
function microsecondsToISOString(microseconds: number): string {
  return new Date(microsecondsToMilliseconds(microseconds)).toISOString();
}
