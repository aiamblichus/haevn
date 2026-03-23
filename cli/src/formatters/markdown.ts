/**
 * Markdown formatter for chat branches.
 */

import type { Chat, ChatMessage } from "../types/chat";
import { formatTimestamp } from "../utils/output";
import { getMessageRole, getMessagesOnBranch, getMessageText } from "../utils/tree";

export interface MarkdownOptions {
  includeMetadata?: boolean;
  includeMedia?: boolean;
}

/**
 * Format a single branch as Markdown.
 */
export function formatBranchAsMarkdown(
  chat: Chat,
  branchPath: string[],
  options: MarkdownOptions = {},
): string {
  const { includeMetadata = true } = options;
  const messages = getMessagesOnBranch(chat, branchPath);

  const lines: string[] = [];

  // Title
  lines.push(`# ${chat.title}`);
  lines.push("");

  // Metadata block
  if (includeMetadata) {
    lines.push(`> ${formatMetadata(chat)}`);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  // Messages
  for (const message of messages) {
    const role = getMessageRole(message);
    const text = getMessageText(message);
    const roleLabel = role === "user" ? "User" : "Assistant";

    lines.push(`## ${roleLabel}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  // Footer with branch info
  lines.push("---");
  lines.push("");
  lines.push(`_Branch: ${branchPath.join(" → ")} (${messages.length} messages)_`);

  return lines.join("\n");
}

/**
 * Format metadata line for header.
 */
function formatMetadata(chat: Chat): string {
  const parts = [
    `Chat ID: \`${chat.id}\``,
    `Platform: ${chat.source}`,
    formatTimestamp(chat.timestamp),
  ];

  return parts.join(" | ");
}

/**
 * Format a search result fragment as Markdown.
 */
export function formatFragmentAsMarkdown(
  chat: Chat,
  messageId: string,
  fragment: string,
  matchStart: number,
  matchEnd: number,
): string {
  const message = chat.messages[messageId];
  if (!message) return "";

  const role = getMessageRole(message);
  const before = fragment.slice(0, matchStart);
  const match = fragment.slice(matchStart, matchEnd);
  const after = fragment.slice(matchEnd);

  const lines: string[] = [];

  lines.push(`**${chat.title}** (chat: \`${chat.id}\`, message: \`${messageId}\`)`);
  lines.push("");
  lines.push(`${before}**${match}**${after}`);
  lines.push("");
  lines.push(`_${role} • ${formatTimestamp(message.timestamp)}_`);

  return lines.join("\n");
}
