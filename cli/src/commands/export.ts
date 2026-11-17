/**
 * Export command – request formatted single-chat exports from extension daemon.
 */

import * as fs from "node:fs";
import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import type { Chat } from "../types/chat";
import { consola, pc } from "../utils/output";

type ExportFormat = "haevn_json" | "haevn_markdown" | "pi_session_jsonl";

interface ExportArtifactResponse {
  format: ExportFormat;
  filename: string;
  contentType: string;
  content: string;
  warnings?: string[];
}

function normalizeFormat(raw: string | undefined): ExportFormat {
  const value = (raw || "haevn_json").toLowerCase();

  if (value === "haevn_json" || value === "json") return "haevn_json";
  if (value === "haevn_markdown" || value === "markdown" || value === "md") {
    return "haevn_markdown";
  }
  if (value === "pi_session_jsonl" || value === "pi" || value === "jsonl") {
    return "pi_session_jsonl";
  }

  throw new Error(`Unsupported export format: ${raw}`);
}

export default defineCommand({
  meta: {
    name: "export",
    description: "Export a single chat via extension exporters (JSON, Markdown, Pi JSONL)",
  },
  args: {
    chatId: {
      type: "positional",
      description: "Chat ID to export",
      required: true,
    },
    output: {
      type: "string",
      alias: "o",
      description: "Output file path (required)",
      required: true,
    },
    format: {
      type: "string",
      alias: "f",
      description: "Export format (haevn_json | haevn_markdown | pi_session_jsonl)",
      default: "haevn_json",
    },
    "all-branches": {
      type: "boolean",
      description:
        "Markdown only: write every branch, each alternative as its own section (default: the current branch). Such a file is for reading and cannot be imported",
      default: false,
    },
  },
  async run({ args }) {
    const { chatId, output } = args;

    let format: ExportFormat;
    try {
      format = normalizeFormat(args.format as string | undefined);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const allBranches = args["all-branches"] === true;
    if (allBranches && format !== "haevn_markdown") {
      consola.warn(`--all-branches only applies to haevn_markdown; ${format} is written as usual.`);
    }

    let artifact: ExportArtifactResponse;
    try {
      artifact = await daemonRequest<ExportArtifactResponse>({
        action: "export",
        chatId,
        options: {
          exporterId: format,
          includeMedia: false,
          ...(allBranches ? { allBranches } : {}),
        },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    fs.writeFileSync(output, artifact.content, "utf8");
    consola.log(formatExportResultSummary(chatId, output, artifact));

    if (artifact.warnings && artifact.warnings.length > 0) {
      for (const warning of artifact.warnings) {
        consola.warn(warning);
      }
    }
  },
});

export function formatExportResultSummary(
  chatId: string,
  outputPath: string,
  artifact: ExportArtifactResponse,
): string {
  const lines = [
    `${pc.green("✓")} Exported ${pc.bold(chatId)} as ${pc.cyan(artifact.format)}`,
    `  ${pc.dim("mime")} ${artifact.contentType}`,
    `  ${pc.dim("→")} ${outputPath}`,
  ];

  return lines.join("\n");
}

// Legacy helper retained for compatibility with prior imports/tests.
export function formatExportSummary(chat: Chat, outputPath: string): string {
  return formatExportResultSummary(chat.id || chat.sourceId, outputPath, {
    format: "haevn_json",
    filename: outputPath,
    contentType: "application/json;charset=utf-8",
    content: "",
  });
}
