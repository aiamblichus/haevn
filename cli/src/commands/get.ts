/**
 * Get command – fetch a branch from a chat, or the whole tree with `--all-branches`, as Markdown or
 * JSON.
 */

import * as fs from "node:fs";
import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { DEFAULT_DAEMON_PORT, loadConfig } from "../daemon/config.js";
import { formatBranchAsJson, formatChatAsJson, toJsonString } from "../formatters/json";
import { formatBranchAsMarkdown, formatChatAsMarkdown } from "../formatters/markdown";
import type { Chat, ChatMessage } from "../types/chat";
import { flagText, parseWholeNumber } from "../utils/args";
import {
  inlineJsonMedia,
  linkMarkdownMedia,
  type MediaReport,
  saveMarkdownMedia,
} from "../utils/media";
import { resolveMessageRef } from "../utils/messageRefs";
import { consola, safeText } from "../utils/output";
import {
  buildChatTree,
  getBranchContainingMessage,
  getMessagesOnBranch,
  getPrimaryBranch,
  treeMessageIds,
  windowMessages,
} from "../utils/tree";

export default defineCommand({
  meta: {
    name: "get",
    description:
      "Fetch a branch from a chat, or every branch with --all-branches, as Markdown or JSON",
  },
  args: {
    chatId: {
      type: "positional",
      description: "Chat ID to fetch",
      required: true,
    },
    message: {
      type: "string",
      alias: "m",
      description: "Message ref or ID – fetch the branch containing this message",
    },
    "all-branches": {
      type: "boolean",
      description:
        "Fetch the whole chat: the trunk once, then every branch (not with -m, --head or --tail)",
      default: false,
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format (markdown, json)",
      default: "markdown",
    },
    output: {
      type: "string",
      alias: "o",
      description: "Write to file instead of stdout",
    },
    "include-metadata": {
      type: "boolean",
      description: "Include timestamps and model info",
      default: true,
    },
    "include-media": {
      type: "boolean",
      description:
        "Include the media: with -o, files in a folder beside it and links to them; as JSON, base64 in each message's media",
      default: false,
    },
    "include-thinking": {
      type: "boolean",
      description: "Include full thinking blocks instead of truncating previews",
      default: false,
    },
    "skip-system": {
      type: "boolean",
      description: "Skip system instructions in output",
      default: false,
    },
    tail: {
      type: "string",
      alias: "t",
      description: "Only show the last N messages",
    },
    head: {
      type: "string",
      description: "Only show the first N messages",
    },
  },
  async run({ args, rawArgs }) {
    const {
      chatId,
      message: messageId,
      format,
      output,
      "include-metadata": includeMetadata,
      "include-media": includeMedia,
      "include-thinking": includeThinking,
      "skip-system": skipSystem,
      "all-branches": allBranches,
    } = args;

    let head: number;
    let tail: number;
    try {
      head = parseWholeNumber("head", flagText(args.head, rawArgs, ["--head"]), 0);
      tail = parseWholeNumber("tail", flagText(args.tail, rawArgs, ["--tail", "-t"]), 0);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (allBranches) {
      const clash = [
        messageId ? "--message" : "",
        head > 0 ? "--head" : "",
        tail > 0 ? "--tail" : "",
      ].filter(Boolean);
      if (clash.length > 0) {
        consola.error(
          `--all-branches writes every branch, so it cannot be combined with ${clash.join(" or ")}. Drop ${clash.length === 1 ? "it" : "them"}, or drop --all-branches to get one branch.`,
        );
        process.exit(1);
      }
    }

    let chat: Chat;
    let resolvedMessageId = messageId;
    try {
      if (allBranches) {
        // The whole tree is what `branches` asks for; `get` answers one branch
        chat = await daemonRequest<Chat>({ action: "branches", chatId });
      } else {
        if (messageId) {
          const branchChat = await daemonRequest<Chat>({ action: "branches", chatId });
          const resolved = resolveMessageRef(branchChat, messageId);
          if (!resolved.messageId) {
            throw new Error(resolved.error || `Could not resolve message reference: ${messageId}`);
          }
          resolvedMessageId = resolved.messageId;
        }

        chat = await daemonRequest<Chat>({
          action: "get",
          chatId,
          options: { messageId: resolvedMessageId, includeMetadata, includeMedia },
        });
      }
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    let content: string;
    let mediaReport: MediaReport | undefined;
    try {
      let mediaText: Map<string, string[]> | undefined;
      let media: Map<string, object[]> | undefined;
      if (includeMedia) {
        // The branch is resolved first, so a message that is not there fails before any fetch. A
        // whole chat is fetched in the order the Markdown shows its messages.
        const shown = allBranches
          ? treeMessages(chat)
          : windowMessages(getMessagesOnBranch(chat, branchOf(chat, resolvedMessageId)), {
              head,
              tail,
            }).messages;
        const config = loadConfig();
        const context = {
          chatId: chat.id ?? chatId,
          endpoint: { port: config.port ?? DEFAULT_DAEMON_PORT, apiKey: config.apiKey ?? "" },
        };
        if (format === "json") {
          const inlined = await inlineJsonMedia(shown, context);
          media = inlined.items;
          mediaReport = inlined;
        } else {
          const saved = output
            ? await saveMarkdownMedia(shown, output, context)
            : linkMarkdownMedia(shown, context);
          mediaText = saved.text;
          mediaReport = saved;
        }
      }

      const rendering = {
        includeMetadata,
        includeThinking,
        skipSystem,
        mediaText,
        media,
      };
      content = allBranches
        ? outputChat(chat, format as "markdown" | "json", rendering)
        : outputBranch(chat, resolvedMessageId, format as "markdown" | "json", {
            ...rendering,
            tail,
            head,
          });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (output) {
      fs.writeFileSync(output, content, "utf8");
      consola.success(`Written to ${output}`);
    } else {
      // Markdown on the terminal carries conversation text, so its control characters
      // become stand-ins. JSON is left as it is, because scripts read it raw.
      const shown = format === "json" ? content : safeText(content);
      process.stdout.write(`${shown}\n`);
    }

    if (mediaReport && !reportMedia(mediaReport)) process.exit(1);
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * What a run with `--include-media` has to say, on stderr. True when every medium asked for is in
 * the output; false when some are not, which fails the command (the output is written all the same).
 */
function reportMedia(report: MediaReport): boolean {
  for (const problem of report.problems) consola.warn(problem);
  if (report.unsaved > 0) {
    consola.warn(
      `${report.unsaved} media ${report.unsaved === 1 ? "file was" : "files were"} not saved: add -o FILE to save them beside it.`,
    );
  }
  if (report.withoutFile > 0) {
    consola.warn(
      `${report.withoutFile} media ${report.withoutFile === 1 ? "item has" : "items have"} no file in the archive to save.`,
    );
  }
  return report.problems.length === 0;
}

function branchOf(chat: Chat, messageId?: string): string[] {
  const branchPath = messageId
    ? getBranchContainingMessage(chat, messageId)
    : getPrimaryBranch(chat);

  if (branchPath.length === 0) {
    throw new Error(
      messageId ? `No branch found containing message ${messageId}` : "Chat has no messages",
    );
  }
  return branchPath;
}

/** The messages of a whole chat, in the order `--all-branches` shows them. */
function treeMessages(chat: Chat): ChatMessage[] {
  if (Object.keys(chat.messages).length === 0) throw new Error("Chat has no messages");
  return treeMessageIds(buildChatTree(chat)).map((id) => chat.messages[id]);
}

/** The whole chat, every branch once (`get --all-branches`), as Markdown or JSON. */
export function outputChat(
  chat: Chat,
  format: "markdown" | "json" = "markdown",
  options: {
    includeMetadata?: boolean;
    includeThinking?: boolean;
    skipSystem?: boolean;
    /** The text for each media item of each message, for Markdown (see `MarkdownOptions`). */
    mediaText?: ReadonlyMap<string, readonly string[]>;
    /** The media items of each message, for JSON (see `ChatJsonOptions`). */
    media?: ReadonlyMap<string, readonly object[]>;
  } = {},
): string {
  treeMessages(chat); // refuses a chat with no messages, as a single branch does

  if (format === "json") {
    return toJsonString(
      formatChatAsJson(chat, {
        includeThinking: options.includeThinking,
        skipSystem: options.skipSystem,
        media: options.media,
      }),
    );
  }

  return formatChatAsMarkdown(chat, {
    includeMetadata: options.includeMetadata ?? true,
    includeThinking: options.includeThinking ?? false,
    skipSystem: options.skipSystem ?? false,
    mediaText: options.mediaText,
  });
}

export function outputBranch(
  chat: Chat,
  messageId?: string,
  format: "markdown" | "json" = "markdown",
  options: {
    includeMetadata?: boolean;
    includeThinking?: boolean;
    skipSystem?: boolean;
    tail?: number;
    head?: number;
    /** The text for each media item of each message, for Markdown (see `MarkdownOptions`). */
    mediaText?: ReadonlyMap<string, readonly string[]>;
    /** The media items of each message, for JSON (see `BranchJsonOptions`). */
    media?: ReadonlyMap<string, readonly object[]>;
  } = {},
): string {
  const branchPath = branchOf(chat, messageId);

  if (format === "json") {
    return toJsonString(
      formatBranchAsJson(chat, branchPath, {
        includeThinking: options.includeThinking,
        skipSystem: options.skipSystem,
        head: options.head,
        tail: options.tail,
        media: options.media,
      }),
    );
  }

  return formatBranchAsMarkdown(chat, branchPath, {
    includeMetadata: options.includeMetadata ?? true,
    mediaText: options.mediaText,
    includeThinking: options.includeThinking ?? false,
    skipSystem: options.skipSystem ?? false,
    tail: options.tail ?? 0,
    head: options.head ?? 0,
  });
}
