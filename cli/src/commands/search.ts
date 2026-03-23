/**
 * Search command – find messages matching a query across all synced chats.
 */

import { defineCommand } from "citty";
import { toJsonString } from "../formatters/json";
import { daemonRequest } from "../daemon/client.js";
import type { SearchResult } from "../types";
import { createMessageRef } from "../utils/messageRefs";
import { consola, formatPlatform, formatRelativeTime, header, pc, truncate } from "../utils/output";

export default defineCommand({
  meta: {
    name: "search",
    description: "Search for messages matching a query",
  },
  args: {
    query: {
      type: "positional",
      description: "Search query",
      required: true,
    },
    platform: {
      type: "string",
      alias: "p",
      description: "Filter by platform",
    },
    limit: {
      type: "string",
      alias: "l",
      description: "Maximum number of chats to scan (default: 20)",
    },
    context: {
      type: "string",
      alias: "c",
      description: "Snippet context window in characters (default: 120)",
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format (text, json)",
      default: "text",
    },
    after: {
      type: "string",
      description: "Only messages after date (YYYY-MM-DD)",
    },
    before: {
      type: "string",
      description: "Only messages before date (YYYY-MM-DD)",
    },
  },
  async run({ args }) {
    const { query, platform, format, after, before, context } = args;
    const limit = args.limit ? Number.parseInt(args.limit, 10) : 20;
    const contextChars = context ? Number.parseInt(context, 10) : 120;

    let results: SearchResult[];
    try {
      results = await daemonRequest<SearchResult[]>({
        action: "search",
        query,
        options: { platform, limit, after, before, contextChars },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format === "json") {
      consola.log(
        toJsonString({
          results: results.map((result) => ({
            ...result,
            messageRef: createMessageRef(result.chatId, result.messageId),
          })),
          total: results.length,
        }),
      );
      return;
    }

    if (results.length === 0) {
      consola.info(`No results for "${query}".`);
      return;
    }

    consola.log(formatSearchResultsText(results));
  },
});

// ─── Formatting ───────────────────────────────────────────────────────────────

/**
 * Render `{{HIGHLIGHT}}…{{/HIGHLIGHT}}` markers from the extension's snippet
 * as bold yellow terminal text.
 */
function renderSnippet(snippet: string): string {
  return snippet.replace(/\{\{HIGHLIGHT\}\}(.*?)\{\{\/HIGHLIGHT\}\}/g, (_match, inner) =>
    pc.bold(pc.yellow(inner)),
  );
}

export function formatSearchResultsText(results: SearchResult[]): string {
  const lines: string[] = [];
  let lastChatId: string | null = null;

  for (const result of results) {
    // Print a chat header each time we enter a new chat.
    if (result.chatId !== lastChatId) {
      lastChatId = result.chatId;
      lines.push("");
      lines.push(header(`${result.chatId}  "${truncate(result.chatTitle, 45)}"`));
    }

    const roleLabel = result.messageRole === "user" ? pc.cyan("user") : pc.magenta("asst");

    const snippet = renderSnippet(result.messageSnippet ?? result.messageContent.slice(0, 150));
    const time = formatRelativeTime(result.messageTimestamp);
    const platform = formatPlatform(result.source);

    lines.push(
      `  ${pc.dim("┌─")} ${pc.dim(`[${createMessageRef(result.chatId, result.messageId)}]`)}`,
    );
    lines.push(`  ${pc.dim("│")} ${snippet}`);
    lines.push(`  ${pc.dim("└─")} ${roleLabel} · ${platform} · ${pc.dim(time)}`);
  }

  lines.push("");
  lines.push(pc.dim(`${results.length} result${results.length === 1 ? "" : "s"}`));
  return lines.join("\n");
}
