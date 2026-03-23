/**
 * Markdown formatter for chat branches.
 */

import type { Chat, ChatMessage } from "../types/chat";
import { formatTimestamp } from "../utils/output";
import { getMessageRole, getMessagesOnBranch, getMessageText } from "../utils/tree";

export interface MarkdownOptions {
  includeMetadata?: boolean;
  includeMedia?: boolean;
  /** Only render the last N messages of the branch (0 = all). */
  tail?: number;
  /** Only render the first N messages of the branch (0 = all). Takes precedence over tail. */
  head?: number;
}

/**
 * Format a single branch as Markdown.
 */
export function formatBranchAsMarkdown(
  chat: Chat,
  branchPath: string[],
  options: MarkdownOptions = {},
): string {
  const { includeMetadata = true, tail = 0, head = 0 } = options;
  let messages = getMessagesOnBranch(chat, branchPath);

  // Apply head/tail window before filtering so the count is accurate.
  // head takes precedence over tail when both are specified.
  const totalMessages = messages.length;
  const headTruncated = head > 0 && head < totalMessages;
  const tailTruncated = !headTruncated && tail > 0 && tail < totalMessages;

  if (headTruncated) {
    messages = messages.slice(0, head);
  } else if (tailTruncated) {
    messages = messages.slice(-tail);
  }

  // Filter out messages with no text (tool calls, image-only uploads)
  const rendered = messages.filter((m) => getMessageText(m).trim());

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

  if (tailTruncated) {
    lines.push(`_…${totalMessages - tail} earlier messages omitted (use without --tail to see all)_`);
    lines.push("");
  }

  // Messages
  for (const message of rendered) {
    const role = getMessageRole(message);
    const text = getMessageText(message);
    const roleLabel = role === "user" ? "User" : "Assistant";

    lines.push(`## ${roleLabel}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  if (headTruncated) {
    lines.push(`_…${totalMessages - head} later messages omitted (use without --head to see all)_`);
    lines.push("");
  }

  // Footer: human-readable count, no raw IDs
  lines.push("---");
  lines.push("");
  const branchCount = chat.branches ? Object.keys(chat.branches).length : 1;
  const footerParts = [`${totalMessages} messages`];
  if (branchCount > 1) footerParts.push(`${branchCount} branches`);
  lines.push(`_${footerParts.join(" · ")}_`);

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
