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
import { log } from "./utils/logger";

export interface ExportOptions {
  includeMetadata?: boolean;
  includeTimestamps?: boolean;
  format: "json" | "markdown";
  messageIds?: string[]; // Optional: limit export to specific messages in order
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
                    mediaType: c.media_type,
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
              attachments.push({
                content: c as BinaryContent,
                mediaType: c.media_type,
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
      log.warn(`Failed to download attachment from ${url}: ${response.statusText}`);
      return null;
    }
    const blob = await response.blob();
    const arrayBuffer = await blob.arrayBuffer();
    const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    return {
      kind: "binary",
      data: base64,
      media_type: mediaType,
    };
  } catch (error) {
    log.error(`Error downloading attachment from ${url}:`, error);
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

  frontmatter.created_at = new Date(chat.timestamp).toISOString();

  if (chat.providerLastModifiedTimestamp) {
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

  const frontmatterYaml = stringifyYaml(frontmatter).trimEnd();
  let content = `---\n${frontmatterYaml}\n---\n\n`;

  const messageIds = options.messageIds || sortMessageIdsByResponseTimestamp(chat);
  const sortedMessageIds = messageIds.filter((id) => chat.messages[id]);

  for (const msgId of sortedMessageIds) {
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
          blocks.push(
            `[Tool Return (${part.tool_name})]: ${JSON.stringify(part.content, null, 2)}`,
          );
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
  }

  return content;
}
