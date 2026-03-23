/**
 * JSON formatter for structured output.
 */

import type { BranchInfo, CliResponse, SearchResult } from "../types";
import type { Chat } from "../types/chat";
import { buildMessageRefIndex, createMessageRef, getMessageRef } from "../utils/messageRefs";
import { getMessageRole, getMessagesOnBranch, getMessageText } from "../utils/tree";

/**
 * Format a branch as JSON for structured output.
 */
export function formatBranchAsJson(chat: Chat, branchPath: string[]): object {
  const messages = getMessagesOnBranch(chat, branchPath);
  const refs = buildMessageRefIndex(chat);

  return {
    chatId: chat.id,
    title: chat.title,
    platform: chat.source,
    timestamp: chat.timestamp,
    branch: {
      path: branchPath.map((id) => getMessageRef(refs, id)),
      messageCount: messages.length,
      messages: messages.map((msg) => ({
        ref: getMessageRef(refs, msg.id),
        role: getMessageRole(msg),
        content: getMessageText(msg),
        timestamp: msg.timestamp,
      })),
    },
  };
}

/**
 * Format search results as JSON.
 */
export function formatSearchResultsAsJson(results: SearchResult[]): object {
  return {
    results: results.map((result) => ({
      ...result,
      messageRef: createMessageRef(result.chatId, result.messageId),
    })),
    total: results.length,
    hasMore: false, // TODO: implement pagination
  };
}

/**
 * Format branches as JSON.
 */
export function formatBranchesAsJson(chat: Chat, branches: BranchInfo[]): object {
  const refs = buildMessageRefIndex(chat);
  return {
    chatId: chat.id,
    title: chat.title,
    branchCount: branches.length,
    branches: branches.map((b) => ({
      leafMessageRef: getMessageRef(refs, b.leafMessageId),
      messageCount: b.messageCount,
      firstPrompt: b.firstPrompt,
      isPrimary: b.isPrimary,
      path: b.path.map((id) => getMessageRef(refs, id)),
    })),
  };
}

/**
 * Stringify with pretty formatting.
 */
export function toJsonString(data: unknown, pretty = true): string {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

/**
 * Format a CLI response for stdout.
 */
export function formatResponse<T>(response: CliResponse<T>, pretty = true): string {
  return toJsonString(response, pretty);
}
