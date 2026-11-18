/**
 * Search command – find messages matching a query across all synced chats.
 */

import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { toJsonString } from "../formatters/json";
import type { SearchResult } from "../types";
import { parseWholeNumber } from "../utils/args";
import { createMessageRef } from "../utils/messageRefs";
import { consola, formatPlatform, formatRelativeTime, header, pc, truncate } from "../utils/output";

export default defineCommand({
  meta: {
    name: "search",
    description:
      "Search for messages matching a query.\n\n" +
      "Search syntax:\n" +
      '  • multi-word query (default AND): haevn search "you may not recognize me"\n' +
      "  • exact phrase: haevn search '\"you may not recognize me\"'\n" +
      '  • exclude term: haevn search "alignment -rlhf"\n' +
      '  • prefix wildcard: haevn search "recurs*"\n' +
      '  • fuzzy term: haevn search "kubernates~2"\n' +
      '  • boost term: haevn search "api^5 design"',
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
    category: {
      type: "string",
      description: 'Filter by metadata category (use "_unset" for unindexed chats)',
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
    "no-metadata": {
      type: "boolean",
      description: "Skip metadata in text and JSON output",
      default: false,
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
    const { query, platform, category, format, after, before, context } = args;
    const includeMetadata = !args["no-metadata"];
    let limit: number;
    let contextChars: number;
    try {
      limit = parseWholeNumber("limit", args.limit, 20, 1);
      contextChars = parseWholeNumber("context", context, 120);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    const hint = getQueryHint(query);

    let results: SearchResult[];
    try {
      results = await daemonRequest<SearchResult[]>({
        action: "search",
        query,
        options: { platform, category, limit, after, before, contextChars, includeMetadata },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format === "json") {
      const jsonResults = includeMetadata
        ? results
        : results.map(({ metadata, metaTitle, ...rest }) => rest);

      consola.log(
        toJsonString({
          results: jsonResults.map((result) => ({
            ...result,
            messageRef: createMessageRef(result.chatId, result.messageId),
          })),
          total: jsonResults.length,
          ...(hint ? { hint } : {}),
        }),
      );
      return;
    }

    if (results.length === 0) {
      consola.info(`No results for "${query}".`);
      if (hint) consola.log(pc.dim(hint));
      return;
    }

    const output = formatSearchResultsText(results, { includeMetadata });
    consola.log(hint ? `${output}\n${pc.dim(hint)}` : output);
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

function getQueryHint(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  const hasQuotedPhrase = /"[^"]+"/.test(trimmed);
  const hasMultipleTerms = trimmed.split(/\s+/).filter(Boolean).length > 1;

  if (!hasMultipleTerms || hasQuotedPhrase) return undefined;

  return (
    "Tip: multi-word search matches terms (AND), not an exact phrase. " +
    "For exact phrase matching, use inner quotes: haevn search '\"you may not recognize me\"'."
  );
}

export function formatSearchResultsText(
  results: SearchResult[],
  options: { includeMetadata?: boolean } = {},
): string {
  const lines: string[] = [];
  const includeMetadata = options.includeMetadata !== false;
  let lastChatId: string | null = null;

  for (const result of results) {
    // Print a chat header each time we enter a new chat.
    if (result.chatId !== lastChatId) {
      lastChatId = result.chatId;
      const displayTitle = includeMetadata
        ? result.metaTitle || result.chatTitle
        : result.chatTitle;
      lines.push("");
      lines.push(header(`${result.chatId}  "${truncate(displayTitle, 45)}"`));

      if (includeMetadata && result.metadata) {
        const description = result.metadata.description?.trim();
        const keywords = result.metadata.keywords ?? [];

        if (description) {
          lines.push(`  ${pc.dim("desc:")} ${pc.dim(description)}`);
        }
        if (keywords.length > 0) {
          lines.push(`  ${pc.dim("keywords:")} ${pc.dim(keywords.join(", "))}`);
        }
      }
    }

    const roleLabel = result.messageRole === "user" ? pc.cyan("user") : pc.magenta("asst");

    const snippet = renderSnippet(result.messageSnippet ?? result.messageContent.slice(0, 150));
    const time = formatRelativeTime(result.messageTimestamp);
    const platform = formatPlatform(result.source);
    const modelSuffix = result.model ? ` · ${pc.dim(truncate(result.model, 24))}` : "";

    lines.push(
      `  ${pc.dim("┌─")} ${pc.dim(`[${createMessageRef(result.chatId, result.messageId)}]`)}`,
    );
    lines.push(`  ${pc.dim("│")} ${snippet}`);
    lines.push(`  ${pc.dim("└─")} ${roleLabel} · ${platform}${modelSuffix} · ${pc.dim(time)}`);
  }

  lines.push("");
  lines.push(pc.dim(`${results.length} result${results.length === 1 ? "" : "s"}`));
  return lines.join("\n");
}
