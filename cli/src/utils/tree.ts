/**
 * Tree traversal utilities for navigating HAEVN chat trees.
 *
 * HAEVN chats use a tree structure where:
 * - messages is a dictionary { messageId: ChatMessage }
 * - Each message has parentId (null for root) and childrenIds[]
 * - currentId points to the "active" message (typically the most recent)
 */

import type { BranchInfo } from "../types";
import type { Chat, ChatMessage } from "../types/chat";

export interface GetMessageTextOptions {
  includeThinking?: boolean;
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
        if (promptPart && "content" in promptPart && typeof promptPart.content === "string") {
          firstPrompt = promptPart.content.slice(0, 60);
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
 * Get the role of a message (user or assistant).
 */
export function getMessageRole(message: ChatMessage): "user" | "assistant" {
  const firstPart = message.message[0];
  if (!firstPart) return "user";
  return firstPart.kind === "request" ? "user" : "assistant";
}

/**
 * Get text content from a message (best effort extraction).
 */
export function getMessageText(message: ChatMessage, options: GetMessageTextOptions = {}): string {
  const { includeThinking = false } = options;
  const parts: string[] = [];

  for (const msg of message.message) {
    if (msg.kind === "request") {
      for (const part of msg.parts) {
        if (part.part_kind === "user-prompt") {
          if (typeof part.content === "string") {
            parts.push(part.content);
          }
        } else if (part.part_kind === "system-prompt") {
          parts.push(part.content);
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

  return parts.join("\n\n");
}

/**
 * Get a short preview of a message (first N chars).
 */
export function getMessagePreview(message: ChatMessage, maxLength = 50): string {
  const text = getMessageText(message);
  const truncated = text.slice(0, maxLength).replace(/\n/g, " ");
  return truncated.length < text.length ? `${truncated}...` : truncated;
}
