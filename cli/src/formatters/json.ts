/**
 * JSON formatter for structured output.
 */

import type { Chat } from "../types/chat";
import { buildMessageRefIndex, getMessageRef } from "../utils/messageRefs";
import { getMessageRole, getMessagesOnBranch, getMessageText } from "../utils/tree";

export interface BranchJsonOptions {
  includeThinking?: boolean;
  skipSystem?: boolean;
}

/**
 * Format a branch as JSON for structured output.
 */
export function formatBranchAsJson(
  chat: Chat,
  branchPath: string[],
  options: BranchJsonOptions = {},
): object {
  const { includeThinking = false, skipSystem = false } = options;
  const messages = getMessagesOnBranch(chat, branchPath).filter((msg) => {
    if (!skipSystem) return true;
    return getMessageRole(msg) !== "system";
  });
  const refs = buildMessageRefIndex(chat);

  return {
    chatId: chat.id,
    title: chat.title,
    platform: chat.source,
    timestamp: chat.timestamp,
    system: !skipSystem ? chat.system : undefined,
    branch: {
      path: branchPath.map((id) => getMessageRef(refs, id)),
      messageCount: messages.length,
      messages: messages.map((msg) => ({
        ref: getMessageRef(refs, msg.id),
        role: getMessageRole(msg),
        content: getMessageText(msg, { includeThinking, skipSystem }),
        timestamp: msg.timestamp,
      })),
    },
  };
}

/**
 * Stringify with pretty formatting.
 */
export function toJsonString(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}
