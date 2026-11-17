/**
 * List command – browse available chats.
 */

import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { toJsonString } from "../formatters/json";
import type { ListMetadataKey } from "../types";
import type { Chat } from "../types/chat";
import { consola, formatPlatform, formatRelativeTime, pc, truncate } from "../utils/output";

const METADATA_KEYS: readonly ListMetadataKey[] = [
  "description",
  "synopsis",
  "categories",
  "keywords",
];

const METADATA_KEY_OPTIONS = [...METADATA_KEYS, "all"] as const;
type MetadataKeyOption = (typeof METADATA_KEY_OPTIONS)[number];

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
    "include-metadata": {
      type: "string",
      alias: "m",
      description:
        "Comma-separated metadata keys to include " +
        `(${METADATA_KEY_OPTIONS.join(", ")}); "all" expands to the four concrete keys`,
    },
  },
  async run({ args }) {
    const { platform, after, sort, format } = args;
    const limit = args.limit ? Number.parseInt(args.limit, 10) : 20;

    let includeMetadata: ListMetadataKey[];
    try {
      includeMetadata = parseMetadataKeys(args["include-metadata"]);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    let response: { chats: Partial<Chat>[]; total: number };
    try {
      response = await daemonRequest<{ chats: Partial<Chat>[]; total: number }>({
        action: "list",
        options: {
          platform,
          limit,
          after,
          sortBy: sort as "lastSynced" | "title" | "messageCount",
          ...(includeMetadata.length > 0 ? { includeMetadata } : {}),
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

    consola.log(formatChatListText(chats, total, { includeMetadata }));
  },
});

// ─── Argument parsing ────────────────────────────────────────────────────────

/**
 * Parse the --include-metadata flag value into a deduplicated, validated list
 * of canonical keys. Returns an empty array when the flag is absent.
 */
export function parseMetadataKeys(input: string | undefined): ListMetadataKey[] {
  if (input == null || input === "") return [];

  const tokens = input
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) return [];

  const validSet: Set<string> = new Set(METADATA_KEY_OPTIONS);
  const invalid = tokens.filter((t) => !validSet.has(t));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown --include-metadata key${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}. ` +
        `Valid options: ${METADATA_KEY_OPTIONS.join(", ")}.`,
    );
  }

  if ((tokens as MetadataKeyOption[]).includes("all")) {
    return [...METADATA_KEYS];
  }

  // Preserve declaration order; deduplicate.
  const seen = new Set<ListMetadataKey>();
  const result: ListMetadataKey[] = [];
  for (const key of METADATA_KEYS) {
    if (tokens.includes(key) && !seen.has(key)) {
      result.push(key);
      seen.add(key);
    }
  }
  return result;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const METADATA_DESC_MAX_LEN = 160;
const METADATA_SYNOPSIS_MAX_LEN = 200;

export function formatChatListText(
  chats: Partial<Chat>[],
  total: number,
  options: { includeMetadata?: ListMetadataKey[] } = {},
): string {
  if (chats.length === 0) {
    return "No chats found.";
  }

  const includeMetadata = options.includeMetadata ?? [];
  const lines: string[] = [];
  lines.push(pc.bold(`Chats  ${pc.dim(`(${chats.length} of ${total})`)}`));
  lines.push("");

  const showMsgCount = chats.some((c) => (c as Record<string, unknown>).messageCount != null);
  const showBranchCount = chats.some((c) => (c as Record<string, unknown>).branchCount != null);

  for (const chat of chats) {
    const id = pc.dim((chat.id ?? "").padEnd(36));
    const rawTitle =
      ((chat as Record<string, unknown>).metaTitle as string | undefined) ??
      chat.title ??
      "(untitled)";
    const title = truncate(rawTitle, 32).padEnd(33);
    const platform = formatPlatform(chat.source ?? "").padEnd(10);
    const time = pc.dim(formatRelativeTime(chat.lastSyncedTimestamp).padStart(9));
    const messageCountValue = Number((chat as Record<string, unknown>).messageCount ?? 0);
    const branchCountValue = Number((chat as Record<string, unknown>).branchCount ?? 0);
    const msgCount = showMsgCount
      ? pc.dim(`${String(messageCountValue || "").padStart(5)} msgs`)
      : "";
    const branchCount = showBranchCount
      ? pc.dim(`${String(branchCountValue || "").padStart(4)} br`)
      : "";
    const heavilyBranched =
      messageCountValue > 0 && branchCountValue > 1 && branchCountValue / messageCountValue >= 0.25;
    const branchBadge = heavilyBranched ? pc.yellow("branched") : "";

    const models = chat.models ?? [];
    const modelLabel = models.length > 0 ? pc.dim(truncate(models[0], 22)) : "";

    lines.push(
      `  ${id}  ${title}  ${platform}  ${time}${msgCount ? `  ${msgCount}` : ""}${
        branchCount ? `  ${branchCount}` : ""
      }${branchBadge ? `  ${branchBadge}` : ""}${modelLabel ? `  ${modelLabel}` : ""}`,
    );

    if (includeMetadata.length > 0) {
      lines.push(...formatMetadataLines(chat, includeMetadata));
    }
  }

  return lines.join("\n");
}

function formatMetadataLines(chat: Partial<Chat>, keys: ListMetadataKey[]): string[] {
  const meta = (chat as Record<string, unknown>).metadata as Record<string, unknown> | undefined;
  if (!meta) return [];

  const lines: string[] = [];
  for (const key of keys) {
    if (key === "description") {
      const value = typeof meta.description === "string" ? meta.description.trim() : "";
      if (value) {
        lines.push(`      ${pc.dim("desc:")} ${pc.dim(truncate(value, METADATA_DESC_MAX_LEN))}`);
      }
    } else if (key === "synopsis") {
      const value = typeof meta.synopsis === "string" ? meta.synopsis.trim() : "";
      if (value) {
        lines.push(
          `      ${pc.dim("synopsis:")} ${pc.dim(truncate(value, METADATA_SYNOPSIS_MAX_LEN))}`,
        );
      }
    } else if (key === "categories") {
      const value = Array.isArray(meta.categories) ? (meta.categories as string[]) : [];
      if (value.length > 0) {
        lines.push(`      ${pc.dim("categories:")} ${pc.dim(value.join(", "))}`);
      }
    } else if (key === "keywords") {
      const value = Array.isArray(meta.keywords) ? (meta.keywords as string[]) : [];
      if (value.length > 0) {
        lines.push(`      ${pc.dim("keywords:")} ${pc.dim(value.join(", "))}`);
      }
    }
  }
  return lines;
}
