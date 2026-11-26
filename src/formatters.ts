import { stringify as stringifyYaml } from "yaml";
import type {
  AudioResponsePart,
  AudioUrl,
  BinaryContent,
  Chat,
  ChatMessage,
  DocumentResponsePart,
  DocumentUrl,
  ImageResponsePart,
  ImageUrl,
  ModelRequest,
  ModelResponse,
  VideoResponsePart,
  VideoUrl,
} from "./model/haevn_model";
import { roughDateOf } from "./model/roughDate";
import { log } from "./utils/logger";
import {
  branchSections,
  currentBranchIds,
  hasMessageTree,
  messageNumber,
  otherBranchCount,
} from "./utils/messageBranches";
import { originAndPath } from "./utils/network_utils";

export type ExporterId = "haevn_zip" | "haevn_json" | "haevn_markdown" | "pi_session_jsonl";

export interface ExportOptions {
  includeMetadata?: boolean;
  includeTimestamps?: boolean;
  /**
   * Legacy content format hint.
   * Current extension export pipeline only supports JSON-backed HAEVN ZIP exports.
   * Kept for compatibility with viewer markdown copy/export helpers.
   */
  format: "json" | "markdown";
  /**
   * Export plugin identifier. Defaults to "haevn_zip" when omitted.
   */
  exporterId?: ExporterId;
  messageIds?: string[]; // Optional: limit export to specific messages in order
  /**
   * Markdown only. Without `messageIds`, the default is the current branch (the path from the
   * root to `currentId`); set this to write every branch, each alternative as its own section.
   * Ignored when `messageIds` is given.
   */
  allBranches?: boolean;
}

/**
 * Generate a filename for exporting a chat.
 * For Claude chats with a conversation ID, uses the ID-based format.
 * Otherwise, uses a sanitized version of the title.
 */
export function generateExportFilename(
  source: string,
  title: string,
  format: "json" | "markdown",
  conversationId?: string,
): string {
  const extension = format === "markdown" ? "md" : "json";

  // For Claude chats with conversation ID, use ID-based naming
  if (source === "claude" && conversationId) {
    return `claude_chat_${conversationId}.${extension}`;
  }

  // Sanitize title: remove/replace characters that are invalid in filenames
  const sanitized = title
    .replace(/[<>:"/\\|?*]/g, "_") // Replace invalid chars with underscore
    .replace(/\s+/g, "_") // Replace whitespace with underscore
    .replace(/_{2,}/g, "_") // Collapse multiple underscores
    .replace(/^_|_$/g, "") // Trim leading/trailing underscores
    .slice(0, 100); // Limit length

  const fallbackName = sanitized || "chat";
  return `${source}_${fallbackName}.${extension}`;
}

export async function generateExportContent(
  chat: Chat,
  options: ExportOptions,
  attachmentMap?: Map<string, string>,
): Promise<string> {
  switch (options.format) {
    case "json":
      return JSON.stringify(chat, null, 2);
    case "markdown":
      return generateMarkdownContent(chat, options, attachmentMap);
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }
}

function sortMessageIdsByResponseTimestamp(chat: Chat): string[] {
  return Object.keys(chat.messages).sort((a, b) => {
    const msgA = chat.messages[a];
    const msgB = chat.messages[b];
    const tsA = extractPrimaryTimestamp(msgA);
    const tsB = extractPrimaryTimestamp(msgB);
    return tsA.localeCompare(tsB);
  });
}

function extractPrimaryTimestamp(message: ChatMessage): string {
  const modelMsg = message.message[0];
  if ((modelMsg as ModelResponse).timestamp) {
    return (modelMsg as ModelResponse).timestamp as string;
  }
  // Fallback to message.timestamp if model response lacks timestamp
  if (message.timestamp) {
    return new Date(message.timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

// Attachment extraction and management

export interface AttachmentInfo {
  content: BinaryContent | ImageUrl | VideoUrl | AudioUrl | DocumentUrl;
  mediaType: string;
  messageId: string;
  partIndex: number;
  isUserContent: boolean;
}

/**
 * Extract all attachments from a chat (both binary and URL-based)
 */
export function extractAttachmentsFromChat(chat: Chat, messageIds?: string[]): AttachmentInfo[] {
  const attachments: AttachmentInfo[] = [];
  let partIndex = 0;

  const targetIds = messageIds || Object.keys(chat.messages);

  for (const msgId of targetIds) {
    const chatMessage = chat.messages[msgId];
    if (!chatMessage) continue;
    const modelMessage = chatMessage.message[0];
    partIndex = 0;

    if (modelMessage.kind === "request") {
      // User message attachments
      (modelMessage as ModelRequest).parts.forEach((part) => {
        if (part.part_kind === "user-prompt") {
          if (Array.isArray(part.content)) {
            part.content.forEach((c) => {
              if (typeof c !== "string") {
                if (c.kind !== "binary") {
                  // URL-based attachment
                  attachments.push({
                    content: c as ImageUrl | VideoUrl | AudioUrl | DocumentUrl,
                    mediaType: inferMediaTypeFromUrl(c),
                    messageId: msgId,
                    partIndex: partIndex++,
                    isUserContent: true,
                  });
                } else {
                  // Binary attachment
                  attachments.push({
                    content: c as BinaryContent,
                    mediaType: inferMediaTypeFromBinary(c as BinaryContent),
                    messageId: msgId,
                    partIndex: partIndex++,
                    isUserContent: true,
                  });
                }
              }
            });
          }
        }
      });
    } else {
      // Assistant message attachments
      (modelMessage as ModelResponse).parts.forEach((part) => {
        if (part.part_kind.endsWith("-response")) {
          const anyPart = part as
            | ImageResponsePart
            | VideoResponsePart
            | AudioResponsePart
            | DocumentResponsePart;
          const c = anyPart.content;
          if (c && typeof c !== "string") {
            if (c.kind === "binary") {
              const partKind = anyPart.part_kind;
              const hint = partKind.startsWith("image")
                ? "image"
                : partKind.startsWith("video")
                  ? "video"
                  : partKind.startsWith("audio")
                    ? "audio"
                    : "document";

              attachments.push({
                content: c as BinaryContent,
                mediaType: inferMediaTypeFromBinary(c as BinaryContent, hint),
                messageId: msgId,
                partIndex: partIndex++,
                isUserContent: false,
              });
            } else if (c.kind?.endsWith("-url")) {
              attachments.push({
                content: c as ImageUrl | VideoUrl | AudioUrl | DocumentUrl,
                mediaType: inferMediaTypeFromUrl(c),
                messageId: msgId,
                partIndex: partIndex++,
                isUserContent: false,
              });
            }
          }
        }
      });
    }
  }

  return attachments;
}

/**
 * Infer media type from URL-based attachment
 */
function inferMediaTypeFromUrl(content: ImageUrl | VideoUrl | AudioUrl | DocumentUrl): string {
  if (content.kind === "image-url") return "image/jpeg";
  if (content.kind === "video-url") return "video/mp4";
  if (content.kind === "audio-url") return "audio/mpeg";
  if (content.kind === "document-url") return "application/pdf";
  return "application/octet-stream";
}

function inferMediaTypeFromBinary(
  content: BinaryContent,
  hint?: "image" | "video" | "audio" | "document",
): string {
  const declared = content.media_type?.toLowerCase() || "";
  if (declared && declared !== "application/octet-stream" && declared !== "binary/octet-stream") {
    return content.media_type;
  }

  // For OPFS-backed content, infer from file extension as a fallback.
  const dataRef = content.data || "";
  const ext = dataRef.split("?")[0].split("#")[0].split(".").pop()?.toLowerCase();

  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  if (ext === "mp4") return "video/mp4";
  if (ext === "webm") return "video/webm";
  if (ext === "mov") return "video/quicktime";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "pdf") return "application/pdf";

  // Last-resort fallback: infer from semantic part kind when available.
  if (hint === "image") return "image/jpeg";
  if (hint === "video") return "video/mp4";
  if (hint === "audio") return "audio/mpeg";
  if (hint === "document") return "application/pdf";

  return content.media_type || "application/octet-stream";
}

/** Base64 of the bytes, in slices: spreading a whole buffer into `fromCharCode` overflows the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  const slice = 0x8000;
  let binary = "";
  for (let at = 0; at < bytes.length; at += slice) {
    binary += String.fromCharCode(...bytes.subarray(at, at + slice));
  }
  return btoa(binary);
}

/**
 * Download URL-based attachment and convert to binary
 */
export async function downloadUrlAttachment(
  url: string,
  mediaType: string,
): Promise<BinaryContent | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.warn(`Failed to download attachment from ${originAndPath(url)}: ${response.statusText}`);
      return null;
    }
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = bytesToBase64(new Uint8Array(arrayBuffer));
    return {
      kind: "binary",
      data: base64,
      media_type: mediaType,
    };
  } catch (error) {
    log.error(`Error downloading attachment from ${originAndPath(url)}:`, error);
    return null;
  }
}

/**
 * Generate sequential filename for attachment
 */
export function generateAttachmentFilename(index: number, mediaType: string): string {
  const extension = getExtensionFromMediaType(mediaType);
  const prefix = getPrefixFromMediaType(mediaType);
  const paddedIndex = String(index).padStart(3, "0");
  return `${prefix}_${paddedIndex}.${extension}`;
}

/**
 * Get file extension from media type
 */
function getExtensionFromMediaType(mediaType: string): string {
  if (mediaType.startsWith("image/")) {
    if (mediaType.includes("png")) return "png";
    if (mediaType.includes("gif")) return "gif";
    if (mediaType.includes("webp")) return "webp";
    return "jpg";
  }
  if (mediaType.startsWith("video/")) {
    if (mediaType.includes("webm")) return "webm";
    if (mediaType.includes("quicktime")) return "mov";
    if (mediaType.includes("x-matroska")) return "mkv";
    return "mp4";
  }
  if (mediaType.startsWith("audio/")) {
    if (mediaType.includes("wav")) return "wav";
    if (mediaType.includes("ogg")) return "ogg";
    if (mediaType.includes("flac")) return "flac";
    if (mediaType.includes("aiff")) return "aiff";
    if (mediaType.includes("aac")) return "aac";
    return "mp3";
  }
  if (mediaType.startsWith("application/pdf")) return "pdf";
  if (mediaType.includes("wordprocessingml")) return "docx";
  if (mediaType.includes("spreadsheetml")) return "xlsx";
  if (mediaType.includes("ms-excel")) return "xls";
  if (mediaType.includes("text/")) {
    if (mediaType.includes("csv")) return "csv";
    if (mediaType.includes("html")) return "html";
    if (mediaType.includes("markdown")) return "md";
    return "txt";
  }
  return "bin";
}

/**
 * Get prefix from media type
 */
function getPrefixFromMediaType(mediaType: string): string {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "document";
}

function generateMarkdownContent(
  chat: Chat,
  options: ExportOptions,
  attachmentMap?: Map<string, string>,
): string {
  const frontmatter: Record<string, unknown> = {
    title: chat.title,
    source: chat.source,
  };

  if (chat.id) {
    frontmatter.conversation_id = chat.id;
  }

  // A chat with a rough date has made-up times (HVN-163): its date is written as the person wrote
  // it, in the form the Markdown importer reads back (HVN-175), and no other time is written for it
  // (HVN-171). The archive's label is for display only. An undated chat has no date line, as a
  // fragment with no `date:` has none.
  const rough = roughDateOf(chat);
  if (!rough) {
    frontmatter.created_at = new Date(chat.timestamp).toISOString();
  } else if (rough.precision !== "unknown") {
    frontmatter.date = rough.text;
  }

  if (!rough && chat.providerLastModifiedTimestamp) {
    frontmatter.modified_at = new Date(chat.providerLastModifiedTimestamp).toISOString();
  }

  if (chat.system) {
    frontmatter.system = chat.system;
  }

  if (chat.models.length > 0) {
    frontmatter.models_used = chat.models;
  }

  if (options.includeMetadata) {
    frontmatter.last_synced_timestamp = new Date(chat.lastSyncedTimestamp).toISOString();
    frontmatter.total_messages = Object.keys(chat.messages).length;
  }

  if (!options.messageIds && hasMessageTree(chat)) {
    if (options.allBranches) {
      frontmatter.branches = "all";
    } else {
      frontmatter.branch = "current";
      const omitted = otherBranchCount(chat);
      if (omitted > 0) {
        frontmatter.other_branches_omitted = omitted;
      }
    }
  }

  const frontmatterYaml = stringifyYaml(frontmatter).trimEnd();
  let content = `---\n${frontmatterYaml}\n---\n\n`;

  if (options.messageIds) {
    // Explicit selection (viewer copy, message pickers): exactly these messages, in this order.
    for (const msgId of options.messageIds.filter((id) => chat.messages[id])) {
      content += renderMarkdownMessage(chat, msgId, attachmentMap);
    }
    return content;
  }

  if (!hasMessageTree(chat)) {
    // Messages without parent or child links have no branches to pick from.
    for (const msgId of sortMessageIdsByResponseTimestamp(chat)) {
      content += renderMarkdownMessage(chat, msgId, attachmentMap);
    }
    return content;
  }

  if (options.allBranches) {
    return content + renderAllBranches(chat, attachmentMap);
  }

  const branch = currentBranchIds(chat);
  // A tree with no way in (a cycle, no root) leaves no branch to follow: keep the messages.
  for (const msgId of branch.length > 0 ? branch : sortMessageIdsByResponseTimestamp(chat)) {
    content += renderMarkdownMessage(chat, msgId, attachmentMap);
  }
  return content;
}

/** First words of a message's text, on one line, for naming a fork point. */
function messageExcerpt(message: ChatMessage, maxLength = 60): string {
  let text = "";
  for (const modelMessage of message.message) {
    for (const part of modelMessage.parts) {
      if (part.part_kind !== "user-prompt" && part.part_kind !== "text") continue;
      const content = part.content;
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content.find((c): c is string => typeof c === "string") ?? "";
      }
      if (text.trim()) break;
    }
    if (text.trim()) break;
  }
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

/**
 * The main path as plain messages (the same text as the default export), then one section per
 * alternative: "## Branch N: at message M", an italic line naming the fork point, then the
 * alternative's messages from the fork onward.
 */
function renderAllBranches(chat: Chat, attachmentMap?: Map<string, string>): string {
  let content = "";
  const sections = branchSections(chat);

  sections.forEach((section, index) => {
    if (section.unlinked) {
      content += "## Unlinked messages\n\n";
      content += "*Messages whose place in the conversation could not be found, oldest first.*\n\n";
    } else if (index > 0) {
      const { forkId, forkSection } = section;
      if (forkId) {
        const number = messageNumber(chat, forkId);
        const where = forkSection ? ` of branch ${forkSection}` : "";
        const excerpt = messageExcerpt(chat.messages[forkId]);
        content += `## Branch ${index}: at message ${number}${where}\n\n`;
        content += `*An alternative to what follows message ${number}${excerpt ? `, “${excerpt}”` : ""}.*\n\n`;
      } else {
        content += `## Branch ${index}: at the start\n\n`;
        content += `*An alternative beginning of the conversation.*\n\n`;
      }
    }
    for (const msgId of section.chain) {
      content += renderMarkdownMessage(chat, msgId, attachmentMap);
    }
  });

  return content;
}

function renderMarkdownMessage(
  chat: Chat,
  msgId: string,
  attachmentMap?: Map<string, string>,
): string {
  let content = "";
  const chatMessage = chat.messages[msgId];
  const modelMessage = chatMessage.message[0];

  const blocks: string[] = [];
  let attachmentIndex = 0;

  if (modelMessage.kind === "request") {
    // User message
    (modelMessage as ModelRequest).parts.forEach((part) => {
      if (part.part_kind === "system-prompt") {
        // System prompts are already in metadata, but we can include them here too
        blocks.push(`[System: ${part.content}]`);
      } else if (part.part_kind === "user-prompt") {
        if (typeof part.content === "string") {
          blocks.push(part.content);
        } else if (Array.isArray(part.content)) {
          part.content.forEach((c) => {
            if (typeof c === "string") {
              blocks.push(c);
            } else {
              // Attachment (binary or URL-based)
              const attachmentKey = `${msgId}_${attachmentIndex}`;
              const filename = attachmentMap?.get(attachmentKey);
              attachmentIndex++; // Increment for next attachment in this message
              if (filename) {
                if (c.kind === "binary") {
                  if (c.media_type.startsWith("image/")) {
                    blocks.push(`![image](attachments/${filename})`);
                  } else if (c.media_type.startsWith("video/")) {
                    blocks.push(`[video](attachments/${filename})`);
                  } else if (c.media_type.startsWith("audio/")) {
                    blocks.push(`[audio](attachments/${filename})`);
                  } else {
                    blocks.push(`[attachment](attachments/${filename})`);
                  }
                } else {
                  // URL-based
                  if (c.kind === "image-url") {
                    blocks.push(`![image](attachments/${filename})`);
                  } else if (c.kind === "video-url") {
                    blocks.push(`[video](attachments/${filename})`);
                  } else if (c.kind === "audio-url") {
                    blocks.push(`[audio](attachments/${filename})`);
                  } else {
                    blocks.push(`[attachment](attachments/${filename})`);
                  }
                }
              } else {
                // No filename mapping, use placeholder
                if (c.kind === "binary") {
                  blocks.push(`[Binary Content: ${c.media_type}]`);
                } else {
                  blocks.push(`[File: ${c.url}]`);
                }
              }
            }
          });
        }
      } else if (part.part_kind === "tool-return") {
        blocks.push(`[Tool Return (${part.tool_name})]: ${JSON.stringify(part.content, null, 2)}`);
      }
    });

    content += `<!-- HAEVN: role="user" -->\n`;
    content += `${blocks.join("\n\n")}\n\n`;
  } else {
    // Assistant message
    const parts = (modelMessage as ModelResponse).parts;
    const thinkingParts = parts.filter((p) => p.part_kind === "thinking");
    const otherParts = parts.filter((p) => p.part_kind !== "thinking");

    // Process thinking parts first
    if (thinkingParts.length > 0) {
      const thinkingContent = thinkingParts.map((p) => p.content).join("\n\n");
      blocks.push(`<details>\n<summary>Thinking</summary>\n\n${thinkingContent}\n</details>`);
    }

    // Then process all other parts
    otherParts.forEach((part) => {
      if (part.part_kind === "text") {
        blocks.push(part.content);
      } else if (part.part_kind === "tool-call") {
        blocks.push(`[Tool Call (${part.tool_name})]: ${JSON.stringify(part.args, null, 2)}`);
      } else if (part.part_kind.endsWith("-response")) {
        const typeLabel = part.part_kind.replace("-response", "");
        const anyPart = part as
          | ImageResponsePart
          | VideoResponsePart
          | AudioResponsePart
          | DocumentResponsePart;
        const c = anyPart.content;
        if (typeof c === "string") {
          blocks.push(`[${typeLabel} Content]: ${c}`);
        } else if (c && typeof c !== "string") {
          // Attachment (binary or URL-based)
          const attachmentKey = `${msgId}_${attachmentIndex}`;
          const filename = attachmentMap?.get(attachmentKey);
          attachmentIndex++; // Increment for next attachment in this message
          if (filename) {
            if (c.kind === "binary") {
              if (c.media_type.startsWith("image/")) {
                blocks.push(`![image](attachments/${filename})`);
              } else if (c.media_type.startsWith("video/")) {
                blocks.push(`[video](attachments/${filename})`);
              } else if (c.media_type.startsWith("audio/")) {
                blocks.push(`[audio](attachments/${filename})`);
              } else {
                blocks.push(`[attachment](attachments/${filename})`);
              }
            } else if (c.kind?.endsWith("-url")) {
              if (c.kind === "image-url") {
                blocks.push(`![image](attachments/${filename})`);
              } else if (c.kind === "video-url") {
                blocks.push(`[video](attachments/${filename})`);
              } else if (c.kind === "audio-url") {
                blocks.push(`[audio](attachments/${filename})`);
              } else {
                blocks.push(`[attachment](attachments/${filename})`);
              }
            }
          } else {
            // No filename mapping, use placeholder
            if (c.kind === "binary") {
              blocks.push(`[Binary ${typeLabel} Content: ${c.media_type}]`);
            } else {
              blocks.push(`[${typeLabel} URL]: ${c.url}`);
            }
          }
        }
      }
    });

    content += `<!-- HAEVN: role="assistant" -->\n`;
    content += `${blocks.join("\n\n")}\n\n`;
  }

  content += `\n`;

  return content;
}
