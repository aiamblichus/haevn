import { v4 as uuidv4 } from "uuid";
import type {
  BinaryContent,
  DocumentUrl,
  HAEVN,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolReturnPart,
  UserContent,
  UserPromptPart,
} from "../../model/haevn_model";
import { log } from "../../utils/logger";
import { processExternalAssets, type UrlAsset } from "../../utils/media_utils";
import type { TransformOptions } from "../interfaces";
import { buildMessageTree, type TreeNode } from "../shared/treeBuilder";
import type {
  ChatAttachment,
  ChatFile,
  ChatFileV2,
  ChatMessageContentPart,
  ChatTranscript,
  Project,
  TextContentPart,
  ThinkingContentPart,
  ToolResultContentPart,
  ToolUseContentPart,
} from "./model";

/**
 * The text a thinking block contributes. Claude now hides the reasoning of newer chats: the block
 * arrives with `thinking: ""`, `thinking_hidden: true` and the reasoning only as `summaries`
 * (HVN-113). The full thinking wins when there is any (older chats, and hidden blocks the API
 * still returns whole); otherwise the summaries are kept, one paragraph each. The canonical
 * ThinkingPart has no summary marker, so a summary is stored as ordinary thinking.
 */
function thinkingText(part: ThinkingContentPart): string {
  if (part.thinking?.trim()) return part.thinking;
  return (part.summaries ?? [])
    .map((s) => (typeof s?.summary === "string" ? s.summary.trim() : ""))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function convertContentParts(
  contentParts: ChatMessageContentPart[],
  timestamp: string,
): (UserPromptPart | TextPart | ThinkingPart | ToolCallPart | ToolReturnPart)[] {
  return contentParts
    .map((part) => {
      switch (part.type) {
        case "text": {
          const textPart = part as TextContentPart;
          return {
            part_kind: "text",
            content: textPart.text,
          } as TextPart;
        }
        case "thinking": {
          const content = thinkingText(part as ThinkingContentPart);
          // A block with neither thinking nor summaries has nothing to keep (an empty part
          // would only trip the text.empty invariant).
          if (!content) return null;
          return {
            part_kind: "thinking",
            content,
          } as ThinkingPart;
        }
        case "tool_use": {
          const toolUsePart = part as ToolUseContentPart;
          return {
            part_kind: "tool-call",
            tool_name: toolUsePart.name,
            args: toolUsePart.input as unknown as Record<string, unknown>,
            tool_call_id: uuidv4(), // Claude model doesn't provide a tool_call_id
          } as ToolCallPart;
        }
        case "tool_result": {
          const toolResultPart = part as ToolResultContentPart;
          return {
            part_kind: "tool-return",
            tool_name: toolResultPart.name,
            content: toolResultPart.content,
            tool_call_id: uuidv4(), // Claude model doesn't provide a tool_call_id
            timestamp: timestamp,
          } as ToolReturnPart;
        }
        default:
          return null;
      }
    })
    .filter((part) => part !== null) as (TextPart | ThinkingPart | ToolCallPart | ToolReturnPart)[];
}

function convertAttachments(attachments: ChatAttachment[]): (BinaryContent | DocumentUrl)[] {
  return attachments.map((attachment) => {
    return {
      kind: "binary",
      data: attachment.extracted_content,
      media_type: attachment.file_type,
      identifier: attachment.file_name,
    } as BinaryContent;
  });
}

/**
 * Convert Claude's files/files_v2 arrays to UrlAsset format for downloading.
 * These contain URL references to images hosted on Claude's servers.
 * We prefer preview_url over thumbnail_url for higher quality.
 */
function convertFilesToUrlAssets(files: (ChatFile | ChatFileV2)[]): UrlAsset[] {
  return files
    .filter((file) => file.file_kind === "image")
    .map((file) => {
      // Prefer preview URL for higher resolution, fall back to thumbnail
      const url = file.preview_url || file.thumbnail_url;
      if (!url) return null;

      // Build absolute URL (Claude URLs are relative to claude.ai)
      const absoluteUrl = url.startsWith("/") ? `https://claude.ai${url}` : url;

      return {
        url: absoluteUrl,
        type: "image/png", // Claude doesn't provide MIME type, assume PNG
        name: file.file_name,
      } as UrlAsset;
    })
    .filter((asset): asset is UrlAsset => asset !== null);
}

/**
 * A human message becomes a request, which keeps its files; any other message becomes a response.
 * The download step and the tree step both ask this, so they agree on which files are kept.
 */
function isUserMessage(claudeMsg: ChatTranscript["chat_messages"][0]): boolean {
  return claudeMsg.sender === "human";
}

function findProjectForConversation(
  transcript: ChatTranscript,
  projects?: Project[] | null,
): Project | null {
  if (!projects || projects.length === 0) return null;
  const name = (transcript?.name || "").toLowerCase();
  if (!name) return null;
  // Simple heuristic: name contains project name or vice versa
  for (const p of projects) {
    const pname = (p.name || "").toLowerCase();
    if (!pname) continue;
    if (name.includes(pname) || pname.includes(name)) return p;
  }
  return null;
}

/**
 * Checks if a Claude chat has at least one message with text content.
 * Returns false if all messages are empty (no user prompts with text, no assistant text parts).
 */
export function hasTextContent(chat: HAEVN.Chat): boolean {
  for (const message of Object.values(chat.messages)) {
    for (const modelMessage of message.message) {
      if (modelMessage.kind === "request") {
        // Check user prompt parts for text content
        const request = modelMessage as ModelRequest;
        for (const part of request.parts) {
          if (part.part_kind === "user-prompt") {
            const userPart = part as UserPromptPart;
            if (typeof userPart.content === "string") {
              if (userPart.content.trim().length > 0) {
                return true;
              }
            } else if (Array.isArray(userPart.content)) {
              // Check if any element in the array is a string with text
              for (const item of userPart.content) {
                if (typeof item === "string" && item.trim().length > 0) {
                  return true;
                }
              }
            }
          }
        }
      } else if (modelMessage.kind === "response") {
        // Check response parts for text content
        const response = modelMessage as ModelResponse;
        for (const part of response.parts) {
          if (part.part_kind === "text") {
            const textPart = part as TextPart;
            if (textPart.content && textPart.content.trim().length > 0) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Convert a Claude transcript to HAEVN format.
 * This is now async to support downloading images to OPFS.
 */
export async function convertClaudeTranscriptToHaevn(
  transcript: ChatTranscript,
  opts?: { projects?: Project[]; media?: TransformOptions["media"] },
): Promise<HAEVN.Chat> {
  const chatId = transcript.uuid;

  log.info("[Claude Transformer] Starting transformation", {
    chatId,
    messageCount: transcript.chat_messages.length,
  });

  // Step 1: Download the file attachments of each user message for OPFS storage. Step 3 attaches
  // them to the user's request only; an assistant message's files would be stored and referenced
  // by nothing (HVN-97), so they are not downloaded.
  const messageMedia: Map<string, UserContent[]> = new Map();

  for (const claudeMsg of transcript.chat_messages) {
    const messageId = claudeMsg.uuid;
    if (!isUserMessage(claudeMsg)) continue;

    // Combine files and files_v2 arrays, deduplicating by file_uuid
    // Both arrays often contain the same images
    const seenUuids = new Set<string>();
    const allFiles: (ChatFile | ChatFileV2)[] = [];

    for (const file of [...(claudeMsg.files || []), ...(claudeMsg.files_v2 || [])]) {
      if (!seenUuids.has(file.file_uuid)) {
        seenUuids.add(file.file_uuid);
        allFiles.push(file);
      }
    }

    if (allFiles.length === 0) {
      messageMedia.set(messageId, []);
      continue;
    }

    // Convert to generic UrlAsset format for the shared utility
    const assets = convertFilesToUrlAssets(allFiles);

    if (assets.length === 0) {
      messageMedia.set(messageId, []);
      continue;
    }

    log.info(`[Claude Transformer] Downloading ${assets.length} image(s) for message ${messageId}`);

    // Process with chatId and messageId for OPFS storage
    // Include credentials for Claude's authenticated image API
    const downloadedContent = await processExternalAssets(assets, {
      logPrefix: "[Claude Transformer]",
      supportAllMediaTypes: true,
      chatId,
      messageId,
      credentials: "include",
      media: opts?.media,
    });

    messageMedia.set(messageId, downloadedContent);
  }

  log.info("[Claude Transformer] Finished downloading all media");

  // Step 2: Convert Claude messages to TreeNode format
  const nodes: TreeNode<{
    claudeMsg: ChatTranscript["chat_messages"][0];
    conversationId: string;
    downloadedMedia: UserContent[];
  }>[] = transcript.chat_messages.map((claudeMsg, index) => {
    const ROOT_UUID = "00000000-0000-4000-8000-000000000000";
    let parentId: string | undefined = claudeMsg.parent_message_uuid;

    if (parentId === ROOT_UUID) {
      // Explicit root message - no parent
      parentId = undefined;
    } else if (!parentId && index > 0) {
      // Fallback for web exports that don't include parent_message_uuid:
      // assume linear chain based on array order
      parentId = transcript.chat_messages[index - 1].uuid;
    }
    // Otherwise, use the parentId as-is (it's a real parent reference)

    return {
      id: claudeMsg.uuid,
      parentId,
      data: {
        claudeMsg,
        conversationId: transcript.uuid,
        downloadedMedia: messageMedia.get(claudeMsg.uuid) || [],
      },
    };
  });

  // Step 3: Build message tree
  const { messages } = buildMessageTree(nodes, (node) => {
    const { claudeMsg, conversationId, downloadedMedia } = node.data;

    let contentParts: (UserPromptPart | TextPart | ThinkingPart | ToolCallPart | ToolReturnPart)[];
    if (claudeMsg.content && claudeMsg.content.length > 0) {
      contentParts = convertContentParts(claudeMsg.content, claudeMsg.created_at);
    } else if (claudeMsg.text) {
      const textAsContentPart: TextContentPart[] = [
        {
          type: "text",
          text: claudeMsg.text,
          start_timestamp: claudeMsg.created_at,
          stop_timestamp: claudeMsg.created_at,
          citations: [],
        },
      ];
      contentParts = convertContentParts(textAsContentPart, claudeMsg.created_at);
    } else {
      contentParts = [];
    }

    // Legacy attachments (with extracted_content as binary)
    const attachments = convertAttachments(claudeMsg.attachments);

    let modelMessage: ModelMessage;

    if (isUserMessage(claudeMsg)) {
      const userPromptPart: UserPromptPart = {
        part_kind: "user-prompt",
        content: contentParts.map((p) => (p as TextPart).content).join("\n"),
        timestamp: claudeMsg.created_at,
      };

      // Add legacy attachments (binary content from extracted_content)
      if (attachments.length > 0) {
        if (typeof userPromptPart.content === "string") {
          userPromptPart.content = [userPromptPart.content, ...attachments];
        } else {
          userPromptPart.content.push(...attachments);
        }
      }

      // Add downloaded media from files/files_v2 (now stored in OPFS)
      if (downloadedMedia.length > 0) {
        if (typeof userPromptPart.content === "string") {
          userPromptPart.content = [userPromptPart.content, ...downloadedMedia];
        } else {
          userPromptPart.content.push(...downloadedMedia);
        }
      }

      modelMessage = {
        kind: "request",
        parts: [userPromptPart],
      } as ModelRequest;
    } else {
      // assistant
      modelMessage = {
        kind: "response",
        parts: contentParts,
        timestamp: claudeMsg.created_at,
        model_name: "Claude", // The model is not in the transcript, so we hardcode it
        vendor_id: claudeMsg.uuid,
      } as ModelResponse;
    }

    return {
      id: node.id,
      parentId: node.parentId,
      childrenIds: [],
      message: [modelMessage],
      model: "Claude",
      done: claudeMsg.stop_reason === "stop_sequence",
      // Milliseconds since epoch
      timestamp: new Date(claudeMsg.created_at).getTime(),
      chatId: conversationId,
    };
  });

  const chat = {
    id: transcript.uuid,
    source: "claude",
    sourceId: transcript.uuid,
    title: transcript.name,
    models: ["Claude"],
    system: "", // May be filled in below from projects
    params: {},
    currentId:
      transcript.current_leaf_message_uuid ||
      (transcript.chat_messages.length > 0
        ? transcript.chat_messages[transcript.chat_messages.length - 1].uuid
        : ""),
    messages: messages,
    tags: [],
    // Milliseconds since epoch
    timestamp: new Date(transcript.created_at).getTime(),
    // Provider last modified timestamp derived from transcript.updated_at
    providerLastModifiedTimestamp: transcript.updated_at
      ? new Date(transcript.updated_at).getTime()
      : undefined,
  } as unknown as HAEVN.Chat; // Sync metadata (checksum, lastSyncedTimestamp, etc.) is set by SyncService

  // If projects provided (from backup), try to attach prompt as system and tag
  const project = findProjectForConversation(transcript, opts?.projects || []);
  if (project && "prompt_template" in project && typeof project.prompt_template === "string") {
    chat.system = project.prompt_template;
    chat.tags = Array.isArray(chat.tags)
      ? [...chat.tags, `project:${project.name}`]
      : [`project:${project.name}`];
  }

  log.info("[Claude Transformer] Chat created", {
    id: chat.id,
    messageCount: Object.keys(messages).length,
  });

  return chat;
}
