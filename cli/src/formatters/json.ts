/**
 * JSON formatter for structured output.
 */

import type { Chat } from "../types/chat";
import { buildMessageRefIndex, getMessageRef } from "../utils/messageRefs";
import { getMessageRole, getMessagesOnBranch, getMessageText, windowMessages } from "../utils/tree";

export interface BranchJsonOptions {
  includeThinking?: boolean;
  skipSystem?: boolean;
  /** As for Markdown: only the first N messages of the branch (0 = all); head wins over tail. */
  head?: number;
  /** As for Markdown: only the last N messages of the branch (0 = all). */
  tail?: number;
  /**
   * The media items of each message by message id (`--include-media`). A message with an entry gets
   * a `media` array; without the option no message does.
   */
  media?: ReadonlyMap<string, readonly object[]>;
}

/**
 * Format a branch as JSON for structured output. `branch.path` always lists the whole branch; the
 * `branch.messages` are the ones a head or tail window keeps, as Markdown keeps them.
 */
export function formatBranchAsJson(
  chat: Chat,
  branchPath: string[],
  options: BranchJsonOptions = {},
): object {
  const { includeThinking = false, skipSystem = false, head = 0, tail = 0, media } = options;
  const cut = windowMessages(getMessagesOnBranch(chat, branchPath), { head, tail });
  const messages = cut.messages.filter((msg) => {
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
        ...(media?.has(msg.id) ? { media: media.get(msg.id) } : {}),
      })),
    },
  };
}

/**
 * Stringify with pretty formatting.
 */
export function toJsonString(data: unknown, pretty = true): string {
  // JSON.stringify escapes C0 but leaves DEL and C1 raw, and some terminals act on C1 (U+009B is
  // a CSI). Escaping them keeps the JSON valid and the parsed value unchanged.
  return JSON.stringify(data, null, pretty ? 2 : 0).replace(
    /[\u007f-\u009f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
