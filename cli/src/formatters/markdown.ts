/**
 * Markdown formatter for chat branches.
 */

import type { Chat, ChatMessage } from "../types/chat";
import { formatTimestamp } from "../utils/output";
import { getMessageRole, getMessagesOnBranch, getMessageText, windowMessages } from "../utils/tree";

export interface MarkdownOptions {
  includeMetadata?: boolean;
  includeMedia?: boolean;
  includeThinking?: boolean;
  skipSystem?: boolean;
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
  const {
    includeMetadata = true,
    includeThinking = false,
    skipSystem = false,
    tail = 0,
    head = 0,
  } = options;
  const allMessages = getMessagesOnBranch(chat, branchPath);
  const totalMessages = allMessages.length;

  // Apply head/tail window before filtering so the count is accurate.
  // head takes precedence over tail when both are specified.
  const cut = windowMessages(allMessages, { head, tail });

  // Filter out messages with no text (tool calls, image-only uploads)
  const rendered = cut.messages.filter((m) => {
    const role = getMessageRole(m);
    if (skipSystem && role === "system") return false;
    return getMessageText(m, { includeThinking, skipSystem }).trim();
  });

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

  if (cut.tailOmitted > 0) {
    lines.push(`_…${cut.tailOmitted} earlier messages omitted (use without --tail to see all)_`);
    lines.push("");
  }

  if (!skipSystem && chat.system?.trim()) {
    lines.push("## SYSTEM");
    lines.push("");
    lines.push(chat.system.trim());
    lines.push("");
  }

  // Messages
  for (const message of rendered) {
    const role = getMessageRole(message);
    const text = formatMessageForMarkdown(message, includeThinking, skipSystem);
    const roleLabel = role === "system" ? "SYSTEM" : role === "user" ? "User" : "Assistant";

    lines.push(`## ${roleLabel}`);
    lines.push("");
    lines.push(text);
    lines.push("");
  }

  if (cut.headOmitted > 0) {
    lines.push(`_…${cut.headOmitted} later messages omitted (use without --head to see all)_`);
    lines.push("");
  }

  // Footer: human-readable count, no raw IDs
  lines.push("---");
  lines.push("");
  const branchCount = Object.values(chat.messages).filter(
    (msg) => msg.childrenIds.length === 0,
  ).length;
  const footerParts = [`${totalMessages} messages`];
  if (branchCount > 1) footerParts.push(`${branchCount} branches`);
  lines.push(`_${footerParts.join(" · ")}_`);

  return lines.join("\n");
}

function formatMessageForMarkdown(
  message: ChatMessage,
  includeThinking: boolean,
  skipSystem: boolean,
): string {
  if (!includeThinking || getMessageRole(message) !== "assistant") {
    return getMessageText(message, { includeThinking, skipSystem });
  }

  const thinkingParts: string[] = [];
  const otherParts: string[] = [];

  for (const msg of message.message) {
    if (msg.kind !== "response") continue;

    for (const part of msg.parts) {
      if (part.part_kind === "thinking") {
        thinkingParts.push(part.content);
      } else if (part.part_kind === "text") {
        otherParts.push(part.content);
      } else if (part.part_kind === "code-execution") {
        otherParts.push(`[code: ${part.code.slice(0, 100)}...]`);
      }
    }
  }

  const blocks: string[] = [];
  if (thinkingParts.length > 0) {
    blocks.push(`<thinking>\n${thinkingParts.join("\n\n")}\n</thinking>`);
  }
  if (otherParts.length > 0) {
    blocks.push(otherParts.join("\n\n"));
  }

  return blocks.join("\n\n");
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
