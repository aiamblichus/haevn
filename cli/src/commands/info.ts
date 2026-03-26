/**
 * Info command – view or edit metadata for a single chat.
 *
 * Usage:
 *   haevn info <chatId>                        # view
 *   haevn info <chatId> --title "My Title"     # set title
 *   haevn info <chatId> --description "..."    # set description
 *   haevn info <chatId> --synopsis "..."       # set synopsis
 *   haevn info <chatId> --keywords "a,b,c"     # set keywords
 *   haevn info <chatId> --categories "x,y"     # set categories
 *   haevn info <chatId> --generate             # AI generation
 *   haevn info <chatId> --format json          # JSON output
 */

import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { toJsonString } from "../formatters/json";
import type { ChatMetadataRecord, MetadataUpdate } from "../types";
import { consola, formatRelativeTime, header, pc, truncate } from "../utils/output";

export default defineCommand({
  meta: {
    name: "info",
    description: "View or edit metadata for a chat",
  },
  args: {
    chatId: {
      type: "positional",
      description: "Chat ID",
      required: true,
    },
    title: {
      type: "string",
      description: "Set the metadata title",
    },
    description: {
      type: "string",
      alias: "d",
      description: "Set the description",
    },
    synopsis: {
      type: "string",
      alias: "s",
      description: "Set the synopsis",
    },
    keywords: {
      type: "string",
      alias: "k",
      description: "Set keywords (comma-separated)",
    },
    categories: {
      type: "string",
      description: "Set categories (comma-separated)",
    },
    generate: {
      type: "boolean",
      alias: "g",
      description: "Generate metadata with AI (requires AI config in settings)",
      default: false,
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format: text (default) or json",
      default: "text",
    },
  },
  async run({ args }) {
    const { chatId, format } = args;

    const hasUpdates =
      args.title !== undefined ||
      args.description !== undefined ||
      args.synopsis !== undefined ||
      args.keywords !== undefined ||
      args.categories !== undefined;

    let record: ChatMetadataRecord | null;

    if (args.generate) {
      consola.info("Generating metadata with AI…");
      try {
        record = await daemonRequest<ChatMetadataRecord>({
          action: "generateMetadata",
          chatId,
        });
      } catch (err) {
        consola.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    } else if (hasUpdates) {
      const metadata: MetadataUpdate = {};
      if (args.title !== undefined) metadata.title = args.title;
      if (args.description !== undefined) metadata.description = args.description;
      if (args.synopsis !== undefined) metadata.synopsis = args.synopsis;
      if (args.keywords !== undefined)
        metadata.keywords = args.keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
      if (args.categories !== undefined)
        metadata.categories = args.categories
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);

      try {
        record = await daemonRequest<ChatMetadataRecord>({
          action: "setMetadata",
          chatId,
          metadata,
        });
      } catch (err) {
        consola.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    } else {
      try {
        record = await daemonRequest<ChatMetadataRecord | null>({
          action: "getMetadata",
          chatId,
        });
      } catch (err) {
        consola.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    }

    if (format === "json") {
      consola.log(toJsonString(record));
      return;
    }

    consola.log(formatMetadataText(chatId, record));
  },
});

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatMetadataText(chatId: string, record: ChatMetadataRecord | null): string {
  const lines: string[] = [];
  lines.push(header(`metadata  ${pc.dim(truncate(chatId, 36))}`));
  lines.push("");

  if (!record || record.source === "unset") {
    lines.push(pc.dim("  No metadata set for this chat."));
    lines.push("");
    lines.push(pc.dim("  Set fields manually:"));
    lines.push(pc.dim(`    haevn info ${truncate(chatId, 20)} --title "My Title"`));
    lines.push(pc.dim("  Or generate with AI (requires AI config in Settings):"));
    lines.push(pc.dim(`    haevn info ${truncate(chatId, 20)} --generate`));
    return lines.join("\n");
  }

  const lbl = (s: string) => pc.dim(`${s}:`.padEnd(15));
  const empty = pc.dim("(not set)");

  lines.push(`  ${lbl("Title")}${record.title || empty}`);
  lines.push(`  ${lbl("Description")}${record.description || empty}`);

  if (record.synopsis) {
    const wrapped = wrapText(record.synopsis, 65);
    lines.push(`  ${lbl("Synopsis")}${wrapped[0]}`);
    for (const l of wrapped.slice(1)) {
      lines.push(`  ${"".padEnd(15)}${l}`);
    }
  } else {
    lines.push(`  ${lbl("Synopsis")}${empty}`);
  }

  lines.push(
    `  ${lbl("Categories")}${record.categories?.length ? record.categories.join(", ") : empty}`,
  );
  lines.push(
    `  ${lbl("Keywords")}${record.keywords?.length ? record.keywords.join(", ") : empty}`,
  );
  lines.push("");

  const sourceLabel = record.source === "ai" ? pc.green("ai") : pc.cyan("manual");
  const updatedLabel = formatRelativeTime(record.updatedAt);
  const generatedSuffix = record.generatedAt
    ? ` · generated ${formatRelativeTime(record.generatedAt)}`
    : "";
  lines.push(
    `  ${pc.dim("source:")} ${sourceLabel}  ${pc.dim(`updated ${updatedLabel}${generatedSuffix}`)}`,
  );

  return lines.join("\n");
}

function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length + word.length + 1 > width && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = current.length === 0 ? word : `${current} ${word}`;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}
