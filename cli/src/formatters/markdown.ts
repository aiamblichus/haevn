/**
 * Markdown formatter for chat branches.
 */

import type { Chat, ChatMessage } from "../types/chat";
import { formatTimestamp } from "../utils/output";
import {
  buildChatTree,
  type GetMessageTextOptions,
  getMediaStandIns,
  getMessageRole,
  getMessagesOnBranch,
  getMessageText,
  standIn,
  type TreeSection,
  windowMessages,
} from "../utils/tree";

export interface MarkdownOptions {
  includeMetadata?: boolean;
  includeThinking?: boolean;
  skipSystem?: boolean;
  /**
   * What stands for each media item of a message (its link, with `--include-media`), by message id
   * and item index. An item with no entry shows as its stand-in, `[image]` and the like.
   */
  mediaText?: ReadonlyMap<string, readonly string[]>;
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
  const { includeMetadata = true, skipSystem = false, tail = 0, head = 0 } = options;
  const allMessages = getMessagesOnBranch(chat, branchPath);
  const totalMessages = allMessages.length;

  // Apply head/tail window before filtering so the count is accurate.
  // head takes precedence over tail when both are specified.
  const cut = windowMessages(allMessages, { head, tail });

  const lines = headerLines(chat, includeMetadata);

  if (cut.tailOmitted > 0) {
    lines.push(`_…${cut.tailOmitted} earlier messages omitted (use without --tail to see all)_`);
    lines.push("");
  }

  lines.push(...systemLines(chat, skipSystem));

  for (const message of cut.messages) lines.push(...messageLines(message, options));

  if (cut.headOmitted > 0) {
    lines.push(`_…${cut.headOmitted} later messages omitted (use without --head to see all)_`);
    lines.push("");
  }

  lines.push(...footerLines(chat, totalMessages));
  return lines.join("\n");
}

/**
 * Format a whole chat as Markdown: the trunk once, then each branch under a heading at its fork.
 *
 * A fork of N branches gives `### Branch 1 of N` ... `### Branch N of N`, in the order the tree
 * stores them; the one that holds the current message says `(current)`. A fork inside branch 2
 * numbers its own branches `2.1`, `2.2`, so nesting shows in the number and every heading stays at
 * the same level, with the messages at `##` as in a single branch. Each message appears once.
 */
export function formatChatAsMarkdown(chat: Chat, options: MarkdownOptions = {}): string {
  const { includeMetadata = true, skipSystem = false } = options;
  const tree = buildChatTree(chat);

  const lines = [...headerLines(chat, includeMetadata), ...systemLines(chat, skipSystem)];

  function section(node: TreeSection, number: string): void {
    let shown = 0;
    for (const id of node.messageIds) {
      const block = messageLines(chat.messages[id], options);
      shown += block.length;
      lines.push(...block);
    }
    // A section of tool calls and results only would otherwise be a heading over nothing
    if (shown === 0 && node.branches.length === 0 && number !== "") {
      lines.push("_This branch holds no text, only tool calls or results._", "");
    }
    forks(node.branches, number);
  }

  function forks(branches: TreeSection[], parent: string): void {
    if (branches.length < 2) {
      for (const branch of branches) section(branch, parent);
      return;
    }
    branches.forEach((branch, index) => {
      const number = parent === "" ? `${index + 1}` : `${parent}.${index + 1}`;
      const current = branch.holdsCurrent ? " (current)" : "";
      lines.push(`### Branch ${number} of ${branches.length}${current}`, "");
      section(branch, number);
    });
  }

  if (tree.roots.length === 1) section(tree.roots[0], "");
  else forks(tree.roots, "");

  if (tree.unlinked.length > 0) {
    lines.push(
      "### Unlinked messages",
      "",
      "_Messages whose place in the conversation could not be found, oldest first._",
      "",
    );
    for (const id of tree.unlinked) lines.push(...messageLines(chat.messages[id], options));
  }

  lines.push(...footerLines(chat, Object.keys(chat.messages).length));
  return lines.join("\n");
}

/** Title and, with metadata, the line under it. */
function headerLines(chat: Chat, includeMetadata: boolean): string[] {
  const lines = [`# ${chat.title}`, ""];
  if (includeMetadata) lines.push(`> ${formatMetadata(chat)}`, "", "---", "");
  return lines;
}

function systemLines(chat: Chat, skipSystem: boolean): string[] {
  if (skipSystem || !chat.system?.trim()) return [];
  return ["## SYSTEM", "", chat.system.trim(), ""];
}

/**
 * One message under its role heading. A message with neither text nor media (a tool call or a tool
 * result), or a system prompt that is skipped, gives no lines.
 */
function messageLines(message: ChatMessage, options: MarkdownOptions): string[] {
  const { includeThinking = false, skipSystem = false, mediaText } = options;
  const role = getMessageRole(message);
  if (skipSystem && role === "system") return [];
  if (!getMessageText(message, { includeThinking, skipSystem }).trim()) return [];

  const text = formatMessageForMarkdown(message, {
    includeThinking,
    skipSystem,
    mediaText: (item, index) => mediaText?.get(message.id)?.[index] ?? standIn(item),
  });
  const roleLabel = role === "system" ? "SYSTEM" : role === "user" ? "User" : "Assistant";
  return [`## ${roleLabel}`, "", text, ""];
}

/** The footer: human-readable count, no raw IDs. */
function footerLines(chat: Chat, totalMessages: number): string[] {
  const branchCount = Object.values(chat.messages).filter(
    (msg) => msg.childrenIds.length === 0,
  ).length;
  const footerParts = [`${totalMessages} messages`];
  if (branchCount > 1) footerParts.push(`${branchCount} branches`);
  return ["---", "", `_${footerParts.join(" · ")}_`];
}

function formatMessageForMarkdown(message: ChatMessage, options: GetMessageTextOptions): string {
  if (!options.includeThinking || getMessageRole(message) !== "assistant") {
    return getMessageText(message, options);
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

  // The media stand-ins come after the text, as getMessageText puts them.
  otherParts.push(...getMediaStandIns(message, options));

  const blocks: string[] = [];
  if (thinkingParts.length > 0) {
    blocks.push(`<thinking>\n${thinkingParts.join("\n\n")}\n</thinking>`);
  }
  const text = otherParts.filter((part) => part !== "");
  if (text.length > 0) {
    blocks.push(text.join("\n\n"));
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
