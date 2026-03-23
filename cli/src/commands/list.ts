/**
 * List command – browse available chats.
 */

import { defineCommand } from "citty";
import { toJsonString } from "../formatters/json";
import { daemonRequest } from "../daemon/client.js";
import type { Chat } from "../types/chat";
import { consola, formatPlatform, formatRelativeTime, pc, truncate } from "../utils/output";

export default defineCommand({
  meta: {
    name: "list",
    description: "List available chats",
  },
  args: {
    platform: {
      type: "string",
      alias: "p",
      description: "Filter by platform",
    },
    limit: {
      type: "string",
      alias: "l",
      description: "Maximum number of results (default: 20)",
    },
    after: {
      type: "string",
      description: "Only chats updated after date (YYYY-MM-DD)",
    },
    sort: {
      type: "string",
      description: "Sort by: lastSynced (default), title, messageCount",
      default: "lastSynced",
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format (text, json)",
      default: "text",
    },
  },
  async run({ args }) {
    const { platform, after, sort, format } = args;
    const limit = args.limit ? Number.parseInt(args.limit, 10) : 20;

    let response: { chats: Partial<Chat>[]; total: number };
    try {
      response = await daemonRequest<{ chats: Partial<Chat>[]; total: number }>({
        action: "list",
        options: {
          platform,
          limit,
          after,
          sortBy: sort as "lastSynced" | "title" | "messageCount",
        },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const { chats, total } = response;

    if (format === "json") {
      consola.log(toJsonString({ chats, total }));
      return;
    }

    consola.log(formatChatListText(chats, total));
  },
});

// ─── Formatting ───────────────────────────────────────────────────────────────

export function formatChatListText(chats: Partial<Chat>[], total: number): string {
  if (chats.length === 0) {
    return "No chats found.";
  }

  const lines: string[] = [];
  lines.push(pc.bold(`Chats  ${pc.dim(`(${chats.length} of ${total})`)}`));
  lines.push("");

  for (const chat of chats) {
    const id = pc.dim((chat.id ?? "").slice(0, 14).padEnd(14));
    const title = truncate(chat.title ?? "(untitled)", 38).padEnd(39);
    const platform = formatPlatform(chat.source ?? "").padEnd(12);
    const time = pc.dim(formatRelativeTime(chat.lastSyncedTimestamp).padStart(9));

    lines.push(`  ${id}  ${title}  ${platform}  ${time}`);
  }

  return lines.join("\n");
}
