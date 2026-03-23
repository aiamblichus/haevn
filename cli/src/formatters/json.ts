/**
 * JSON formatter for structured output.
 */

import type { BranchInfo, CliResponse, SearchResult } from "../types";
import type { Chat } from "../types/chat";
import { getMessageRole, getMessagesOnBranch, getMessageText } from "../utils/tree";

/**
 * Format a branch as JSON for structured output.
 */
export function formatBranchAsJson(chat: Chat, branchPath: string[]): object {
  const messages = getMessagesOnBranch(chat, branchPath);

  return {
    chatId: chat.id,
    title: chat.title,
    platform: chat.source,
    timestamp: chat.timestamp,
    branch: {
      path: branchPath,
      messageCount: messages.length,
      messages: messages.map((msg) => ({
        id: msg.id,
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
    results,
    total: results.length,
    hasMore: false, // TODO: implement pagination
  };
}

/**
 * Format branches as JSON.
 */
export function formatBranchesAsJson(chat: Chat, branches: BranchInfo[]): object {
  return {
    chatId: chat.id,
    title: chat.title,
    branchCount: branches.length,
    branches: branches.map((b) => ({
      leafMessageId: b.leafMessageId,
      messageCount: b.messageCount,
      firstPrompt: b.firstPrompt,
      isPrimary: b.isPrimary,
      path: b.path,
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
