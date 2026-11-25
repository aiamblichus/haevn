/**
 * Poe to HAEVN Transformer
 * Converts Poe GraphQL API responses to HAEVN.Chat format
 */

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
import { charsOf } from "../../utils/logShape";
import { processExternalAssets, type UrlAsset } from "../../utils/media_utils";
import type { TransformOptions } from "../interfaces";
import { stableMessageIds } from "../shared/stableIds";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type { Message, PoeConversationData } from "./model";

// ============================================================================
// Main Transform Function
// ============================================================================

export async function transformPoeToHaevn(
  poeData: PoeConversationData,
  options?: TransformOptions,
): Promise<HAEVN.Chat[]> {
  log.info("[Poe Transformer] Starting transformation", {
    chatCode: poeData.chatCode,
    messageCount: poeData.messages.length,
  });

  const chat = await createChat(poeData, options);
  return [chat];
}

// ============================================================================
// Chat Creation
// ============================================================================

async function createChat(poeData: PoeConversationData, options?: TransformOptions): Promise<Chat> {
  // Identify which message indices should be new roots (after chat breaks)
  // and filter out the chat_break messages themselves
  const newRootIndices = new Set<number>();
  newRootIndices.add(0); // First message is always a root

  const sorted = poeData.messages.sort((a, b) => a.creationTime - b.creationTime);

  const realMessages: Message[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i];
    if (isChatBreakMarker(msg)) {
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

  // The same message gets the same id on every sync, so its media files keep their names (HVN-90)
  const chatId = poeData.chatCode;
  const messageIds = await stableMessageIds(
    chatId,
    realMessages.map((msg, position) => poeMessageSeed(msg, position)),
  );

  // Process attachments per message to enable OPFS storage with proper chatId/messageId context
  // This is slightly slower than batch download but enables proper media storage
  // We track inline attachments separately so we can strip their markdown references from text
  const messageAttachments: Map<number, { content: UserContent[]; inlineUrls: string[] }> =
    new Map();

  for (let i = 0; i < realMessages.length; i++) {
    const msg = realMessages[i];
    const messageId = messageIds[i];
    const isAssistant = !isUserMessage(msg);

    // Poe sometimes carries image URLs in markdown text even when `attachments` is empty.
    // We parse those URLs so image-only replies still survive provider schema changes.
    const markdownImageUrls = extractInlineImageUrlsFromMarkdown(msg.text || "");

    // Build attachment list from both structured attachments and markdown-extracted URLs.
    const assetMap = new Map<string, UrlAsset>();
    for (const att of msg.attachments) {
      const url = att.url || att.file?.url;
      if (!url) continue;
      assetMap.set(url, {
        url,
        type: att.file?.mimeType,
        name: att.name,
      });
    }
    for (const url of markdownImageUrls) {
      if (!assetMap.has(url)) {
        assetMap.set(url, {
          url,
          // Best effort default; processExternalAssets can refine from response headers.
          type: "image/jpeg",
        });
      }
    }
    const assets = [...assetMap.values()];

    if (assets.length === 0) {
      messageAttachments.set(i, { content: [], inlineUrls: [] });
      continue;
    }

    // Collect inline URLs for assistant messages (used to strip inline markdown after media extraction).
    const inlineUrls: string[] = [];
    if (isAssistant) {
      for (const att of msg.attachments) {
        if (!att.isInline) continue;
        if (att.url) inlineUrls.push(att.url);
        if (att.file?.url && att.file.url !== att.url) inlineUrls.push(att.file.url);
      }
      inlineUrls.push(...markdownImageUrls);
    }

    const dedupedInlineUrls = [...new Set(inlineUrls)];

    // Debug: log attachment URLs vs what's in the message text
    if (isAssistant && assets.length > 0) {
      // Counts only: the text, and the URLs (which can name a file), stay out of the log.
      log.debug(`[Poe Transformer] Attachment debug for message ${i}:`, {
        text: charsOf(msg.text),
        attachments: msg.attachments.length,
        inlineAttachments: msg.attachments.filter((att) => att.isInline).length,
        markdownImageUrls: markdownImageUrls.length,
        resolvedAssetUrls: assets.length,
        collectedInlineUrls: dedupedInlineUrls.length,
      });
    }

    log.info(
      `[Poe Transformer] Downloading ${assets.length} attachments for message ${i + 1}/${realMessages.length}`,
    );

    // Process with chatId and messageId for OPFS storage
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[Poe Transformer]",
      supportAllMediaTypes: true,
      chatId,
      messageId,
      media: options?.media,
    });

    messageAttachments.set(i, { content: downloadedContent, inlineUrls: dedupedInlineUrls });
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
    const isUser = isUserMessage(message);
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

  // A failed reply has no text, and Poe says why in messageStateText (HVN-112): keep the reason.
  if (parts.length === 0 && message.messageStateText?.trim()) {
    parts.push({
      part_kind: "text",
      content: message.messageStateText.trim(),
    } as TextPart);
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
 * Whether the user wrote the message. Poe marks a user turn by `authorUser` and a bot turn by
 * `bot` (HVN-112); there is no `author` field to read.
 */
function isUserMessage(msg: Message): boolean {
  return msg.authorUser != null;
}

/**
 * Whether a message is Poe's context-clear marker: a user turn with no text and no attachment.
 * Poe used to send it as `author: "chat_break"`. It is not a prompt, so it is not rendered as one;
 * the next real message starts a new root, as the chat_break did, so the break survives in the
 * tree (HVN-112). Only a user turn counts: an empty bot turn is a failed reply, and it stays.
 */
function isChatBreakMarker(msg: Message): boolean {
  return isUserMessage(msg) && (msg.text || "").trim() === "" && msg.attachments.length === 0;
}

/**
 * What names a Poe message across syncs: the id Poe gives it, or failing that its numeric id or
 * its code. Only a message with none of the three falls back to its place in the conversation.
 */
function poeMessageSeed(msg: Message, position: number): string {
  if (msg.id) return `id:${msg.id}`;
  if (typeof msg.messageId === "number") return `mid:${msg.messageId}`;
  if (msg.messageCode) return `code:${msg.messageCode}`;
  const role = isUserMessage(msg) ? "user" : "bot";
  return `pos:${position}:${role}:${msg.creationTime}`;
}

/**
 * Extract inline image URLs from markdown text.
 *
 * Supports:
 * 1) Direct image markdown: ![alt](https://...)
 * 2) Reference-style definitions used by Poe: [refId]: https://...
 */
function extractInlineImageUrlsFromMarkdown(text: string): string[] {
  if (!text) return [];

  const urls = new Set<string>();

  // Pattern 1: direct inline markdown image URLs
  const directPattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let directMatch: RegExpExecArray | null;
  directMatch = directPattern.exec(text);
  while (directMatch !== null) {
    urls.add(directMatch[1]);
    directMatch = directPattern.exec(text);
  }

  // Pattern 2: reference-style markdown definitions
  const refDefPattern = /^\[[^\]]+\]:\s*(https?:\/\/\S+)\s*$/gm;
  let refMatch: RegExpExecArray | null;
  refMatch = refDefPattern.exec(text);
  while (refMatch !== null) {
    urls.add(refMatch[1]);
    refMatch = refDefPattern.exec(text);
  }

  return [...urls];
}

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
    refMatch = refDefPattern.exec(result);
    while (refMatch !== null) {
      refIds.push(refMatch[1]);
      refMatch = refDefPattern.exec(result);
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
