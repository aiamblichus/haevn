/**
 * Get command – fetch a single branch from a chat as Markdown or JSON.
 */

import * as fs from "node:fs";
import { defineCommand } from "citty";
import { formatBranchAsJson, toJsonString } from "../formatters/json";
import { formatBranchAsMarkdown } from "../formatters/markdown";
import { daemonRequest } from "../daemon/client.js";
import type { Chat } from "../types/chat";
import { resolveMessageRef } from "../utils/messageRefs";
import { consola } from "../utils/output";
import { getBranchContainingMessage, getPrimaryBranch } from "../utils/tree";

export default defineCommand({
  meta: {
    name: "get",
    description: "Fetch a single branch from a chat as Markdown or JSON",
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
      description: "Include image descriptions/links",
      default: false,
    },
    tail: {
      type: "string",
      alias: "t",
      description: "Only show the last N messages",
    },
  },
  async run({ args }) {
    const {
      chatId,
      message: messageId,
      format,
      output,
      "include-metadata": includeMetadata,
      "include-media": includeMedia,
      tail,
    } = args;

    let chat: Chat;
    let resolvedMessageId = messageId;
    try {
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
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    let content: string;
    try {
      content = outputBranch(chat, resolvedMessageId, format as "markdown" | "json", {
        includeMetadata,
        includeMedia,
        tail: tail ? Number.parseInt(tail, 10) : 0,
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (output) {
      fs.writeFileSync(output, content, "utf8");
      consola.success(`Written to ${output}`);
    } else {
      process.stdout.write(`${content}\n`);
    }
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function outputBranch(
  chat: Chat,
  messageId?: string,
  format: "markdown" | "json" = "markdown",
  options: { includeMetadata?: boolean; includeMedia?: boolean; tail?: number } = {},
): string {
  const branchPath = messageId
    ? getBranchContainingMessage(chat, messageId)
    : getPrimaryBranch(chat);

  if (branchPath.length === 0) {
    throw new Error(
      messageId ? `No branch found containing message ${messageId}` : "Chat has no messages",
    );
  }

  if (format === "json") {
    return toJsonString(formatBranchAsJson(chat, branchPath));
  }

  return formatBranchAsMarkdown(chat, branchPath, {
    includeMetadata: options.includeMetadata ?? true,
    includeMedia: options.includeMedia ?? false,
    tail: options.tail ?? 0,
  });
}
