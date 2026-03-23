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

  const showMsgCount = chats.some((c) => (c as Record<string, unknown>).messageCount != null);
  const showBranchCount = chats.some((c) => (c as Record<string, unknown>).branchCount != null);

  for (const chat of chats) {
    const id = pc.dim((chat.id ?? "").padEnd(36));
    const title = truncate(chat.title ?? "(untitled)", 32).padEnd(33);
    const platform = formatPlatform(chat.source ?? "").padEnd(10);
    const time = pc.dim(formatRelativeTime(chat.lastSyncedTimestamp).padStart(9));
    const messageCountValue = Number((chat as Record<string, unknown>).messageCount ?? 0);
    const branchCountValue = Number((chat as Record<string, unknown>).branchCount ?? 0);
    const msgCount = showMsgCount
      ? pc.dim(String(messageCountValue || "").padStart(5) + " msgs")
      : "";
    const branchCount = showBranchCount ? pc.dim(String(branchCountValue || "").padStart(4) + " br") : "";
    const heavilyBranched =
      messageCountValue > 0 && branchCountValue > 1 && branchCountValue / messageCountValue >= 0.25;
    const branchBadge = heavilyBranched ? pc.yellow("branched") : "";

    // Show first model name when it adds info beyond the platform name (e.g. openwebui, poe)
    const models = chat.models ?? [];
    const modelLabel =
      models.length > 0
        ? pc.dim(truncate(models[0], 22))
        : "";

    lines.push(
      `  ${id}  ${title}  ${platform}  ${time}${msgCount ? `  ${msgCount}` : ""}${
        branchCount ? `  ${branchCount}` : ""
      }${branchBadge ? `  ${branchBadge}` : ""}${modelLabel ? `  ${modelLabel}` : ""}`,
    );
  }

  return lines.join("\n");
}
