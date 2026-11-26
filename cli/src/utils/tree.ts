/**
 * Tree traversal utilities for navigating HAEVN chat trees.
 *
 * HAEVN chats use a tree structure where:
 * - messages is a dictionary { messageId: ChatMessage }
 * - Each message has parentId (null for root) and childrenIds[]
 * - currentId points to the "active" message (typically the most recent)
 */

import type { BranchInfo } from "../types";
import type { Chat, ChatMessage, ModelResponsePart, UserContent } from "../types/chat";

export interface GetMessageTextOptions {
  includeThinking?: boolean;
  skipSystem?: boolean;
  /**
   * What stands for each media item of the message, by its index in `getMediaItems`. The default is
   * the bare `[image]`, `[video]`, `[audio]` or `[file]`.
   */
  mediaText?: (item: MediaItem, index: number) => string;
}

/**
 * Find the root message of a chat tree.
 */
export function findRoot(chat: Chat): ChatMessage | null {
  for (const msg of Object.values(chat.messages)) {
    if (!msg.parentId) {
      return msg;
    }
  }
  return null;
}

/**
 * Get all leaf nodes (messages with no children) in the tree.
 */
export function findLeaves(chat: Chat): ChatMessage[] {
  return Object.values(chat.messages).filter((msg) => msg.childrenIds.length === 0);
}

/**
 * Get the path from root to a specific message.
 * Returns array of message IDs from root to target (inclusive).
 */
export function getPathToMessage(chat: Chat, targetId: string): string[] {
  const path: string[] = [];
  let current: ChatMessage | undefined = chat.messages[targetId];

  if (!current) {
    return [];
  }

  // Walk backwards from target to root
  while (current) {
    path.unshift(current.id);
    current = current.parentId ? chat.messages[current.parentId] : undefined;
  }

  return path;
}

/**
 * The text of a prompt: its content, or for a list (a prompt with attachments) its string items in
 * order, joined as the text view joins parts. Attachments are not text and add nothing here.
 */
function promptText(content: string | UserContent[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is string => typeof item === "string" && item !== "")
    .join("\n\n");
}

/**
 * Get all branches in a chat tree.
 * A branch is defined by its leaf node and the path to it.
 */
export function getAllBranches(chat: Chat): BranchInfo[] {
  const leaves = findLeaves(chat);
  const primaryPath = getPathToMessage(chat, chat.currentId);

  return leaves.map((leaf) => {
    const path = getPathToMessage(chat, leaf.id);
    const firstUserMsg = path
      .map((id) => chat.messages[id])
      .find((msg) => msg.message[0]?.kind === "request");

    // Extract first prompt text
    let firstPrompt: string | undefined;
    if (firstUserMsg) {
      const userPart = firstUserMsg.message[0];
      if (userPart?.kind === "request") {
        const promptPart = userPart.parts.find((p) => p.part_kind === "user-prompt");
        if (promptPart?.part_kind === "user-prompt") {
          firstPrompt = promptText(promptPart.content).slice(0, 60);
        }
      }
    }

    return {
      leafMessageId: leaf.id,
      path,
      messageCount: path.length,
      firstPrompt,
      isPrimary: path[path.length - 1] === primaryPath[primaryPath.length - 1],
    };
  });
}

/**
 * Get the "primary" branch (the one containing currentId).
 * This is the default branch shown when no specific message is requested.
 */
export function getPrimaryBranch(chat: Chat): string[] {
  return getPathToMessage(chat, chat.currentId);
}

/**
 * Get a specific branch that contains a given message.
 */
export function getBranchContainingMessage(chat: Chat, messageId: string): string[] {
  return getPathToMessage(chat, messageId);
}

/**
 * Get messages along a branch path.
 */
export function getMessagesOnBranch(chat: Chat, path: string[]): ChatMessage[] {
  return path.map((id) => chat.messages[id]).filter(Boolean);
}

/**
 * The head or tail window that `get --head` and `get --tail` cut from a branch's messages. head
 * wins over tail; 0 means no window. Markdown and JSON both cut through here, so they cut the same
 * messages. `headOmitted` and `tailOmitted` count what the window left out at each end.
 */
export function windowMessages<T>(
  messages: readonly T[],
  limits: { head?: number; tail?: number },
): { messages: T[]; headOmitted: number; tailOmitted: number } {
  const { head = 0, tail = 0 } = limits;
  const total = messages.length;
  if (head > 0 && head < total) {
    return { messages: messages.slice(0, head), headOmitted: total - head, tailOmitted: 0 };
  }
  if (tail > 0 && tail < total) {
    return { messages: messages.slice(-tail), headOmitted: 0, tailOmitted: total - tail };
  }
  return { messages: [...messages], headOmitted: 0, tailOmitted: 0 };
}

/**
 * Get the role of a message (system, user, or assistant).
 */
export function getMessageRole(message: ChatMessage): "system" | "user" | "assistant" {
  if (message.message.some((m) => m.kind === "response")) {
    return "assistant";
  }

  const requestParts = message.message.filter((m) => m.kind === "request").flatMap((m) => m.parts);

  if (requestParts.length === 0) return "user";

  const hasSystemPrompt = requestParts.some((p) => p.part_kind === "system-prompt");
  const hasNonSystemPrompt = requestParts.some((p) => p.part_kind !== "system-prompt");

  return hasSystemPrompt && !hasNonSystemPrompt ? "system" : "user";
}

/** What a media item is, and so how the text view names it: `[image]`, `[video]`, `[audio]` or `[file]`. */
export type MediaKind = "image" | "video" | "audio" | "file";

/**
 * Where a media item's content is, as the archive holds it:
 *
 * - `stored`: `data` is the path of a file in the extension's store (`media/<chat>/<name>`). Every
 *   provider's download ends this way, and so does an import.
 * - `inline`: `data` is the content itself (base64 for ChatGPT's images; a provider may leave text
 *   there), or nothing when the part has no content.
 * - `url`: a link only, nothing was downloaded.
 */
export type MediaSource =
  | { type: "stored"; path: string }
  | { type: "inline"; data: string }
  | { type: "url"; url: string };

/** One media item of a message: what the text view shows as `[image]` and the like. */
export interface MediaItem {
  kind: MediaKind;
  source: MediaSource;
  /** The media type the archive records. A link has none. */
  mediaType?: string;
  /** The file name the provider gave it, when it did. */
  name?: string;
}

function mediaKindOfType(mediaType: string): MediaKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("video/")) return "video";
  if (mediaType.startsWith("audio/")) return "audio";
  return "file";
}

const URL_KINDS: Record<string, MediaKind> = {
  "image-url": "image",
  "video-url": "video",
  "audio-url": "audio",
};

/** A prompt's item, or a reply's content, as a media item. `kind` is the reply part's own, when it has one. */
function itemOf(
  content: Exclude<UserContent, string> | undefined,
  kind: MediaKind | undefined,
): MediaItem {
  // A part with no content (a damaged record) is still an item, as the text view has always shown it
  if (!content) return { kind: kind ?? "file", source: { type: "inline", data: "" } };
  if (content.kind === "binary") {
    const data = typeof content.data === "string" ? content.data : "";
    const stored = /^\/?(media\/.+)$/.exec(data);
    return {
      kind: kind ?? mediaKindOfType(content.media_type ?? ""),
      source: stored ? { type: "stored", path: stored[1] } : { type: "inline", data },
      mediaType: content.media_type,
      ...(content.identifier ? { name: content.identifier } : {}),
    };
  }
  return {
    kind: kind ?? URL_KINDS[content.kind] ?? "file",
    source:
      typeof content.url === "string"
        ? { type: "url", url: content.url }
        : { type: "inline", data: "" },
  };
}

/** The kind of a media part of a reply, or undefined for a part that is not media. */
function responseMediaKind(part: ModelResponsePart): MediaKind | undefined {
  switch (part.part_kind) {
    case "image-response":
      return "image";
    case "video-response":
      return "video";
    case "audio-response":
      return "audio";
    case "document-response":
      return "file";
    default:
      return undefined;
  }
}

/**
 * The media items of a message, in part order: a reply's image, video, audio or document part, and
 * a prompt's non-text items. The text view shows each as a stand-in; `--include-media` fetches them.
 */
export function getMediaItems(message: ChatMessage): MediaItem[] {
  const items: MediaItem[] = [];

  for (const msg of message.message) {
    if (msg.kind === "request") {
      for (const part of msg.parts) {
        if (part.part_kind === "user-prompt" && Array.isArray(part.content)) {
          for (const entry of part.content) {
            if (typeof entry !== "string") items.push(itemOf(entry, undefined));
          }
        }
      }
    } else {
      for (const part of msg.parts) {
        const kind = responseMediaKind(part);
        if (kind) {
          items.push(itemOf((part as { content?: Exclude<UserContent, string> }).content, kind));
        }
      }
    }
  }

  return items;
}

/** The stand-in for one media item in the text view. */
export function standIn(item: MediaItem): string {
  return `[${item.kind}]`;
}

/**
 * The stand-in for each media item of a message, in part order: a reply's image, video, audio or
 * document part, and a prompt's non-text items. `options.mediaText` says what stands for an item.
 */
export function getMediaStandIns(
  message: ChatMessage,
  options: Pick<GetMessageTextOptions, "mediaText"> = {},
): string[] {
  const text = options.mediaText ?? standIn;
  return getMediaItems(message).map((item, index) => text(item, index));
}

/**
 * Get text content from a message (best effort extraction).
 */
export function getMessageText(message: ChatMessage, options: GetMessageTextOptions = {}): string {
  const { includeThinking = false, skipSystem = false } = options;
  const parts: string[] = [];

  for (const msg of message.message) {
    if (msg.kind === "request") {
      for (const part of msg.parts) {
        if (part.part_kind === "user-prompt") {
          parts.push(promptText(part.content));
        } else if (part.part_kind === "system-prompt") {
          if (!skipSystem) {
            parts.push(part.content);
          }
        }
      }
    } else if (msg.kind === "response") {
      for (const part of msg.parts) {
        if (part.part_kind === "text") {
          parts.push(part.content);
        } else if (part.part_kind === "thinking") {
          if (includeThinking) {
            parts.push(part.content);
          } else {
            parts.push(`[thinking: ${part.content.slice(0, 100)}...]`);
          }
        } else if (part.part_kind === "code-execution") {
          parts.push(`[code: ${part.code.slice(0, 100)}...]`);
        }
      }
    }
  }

  // The stand-ins follow the text, so a message with both shows both, and a message with only media
  // is never blank. An empty text part makes no block.
  return [...parts, ...getMediaStandIns(message, options)]
    .filter((part) => part !== "")
    .join("\n\n");
}

/**
 * Get a short preview of a message (first N chars).
 */
export function getMessagePreview(message: ChatMessage, maxLength = 50): string {
  const text = getMessageText(message);
  const truncated = text.slice(0, maxLength).replace(/\n/g, " ");
  return truncated.length < text.length ? `${truncated}...` : truncated;
}
