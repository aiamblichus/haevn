/**
 * Import command - import local transcript artifacts into HAEVN archive.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import type { ImportFilePayload, ImportFormat, ImportResult } from "../types";
import { consola, pc } from "../utils/output";

export default defineCommand({
  meta: {
    name: "import",
    description: "Import transcript artifacts (Claude Code or Codex JSONL)",
  },
  args: {
    format: {
      type: "string",
      required: true,
      description: "Input format (claude_code|codex)",
    },
    file: {
      type: "positional",
      description: "Input file path (first file)",
      required: true,
    },
    "no-overwrite": {
      type: "boolean",
      description: "Skip chats that already exist (default is overwrite)",
      default: false,
    },
    "skip-index": {
      type: "boolean",
      description: "Skip search indexing after import",
      default: false,
    },
  },
  async run({ args }) {
    const format = args.format as ImportFormat;
    const overwrite = !args["no-overwrite"];
    const skipIndex = args["skip-index"];
    const extraPositional = (args._ || []).map(String).filter(Boolean);
    const rawFiles = [String(args.file), ...extraPositional].filter(Boolean);
    const seen = new Set<string>();
    const files = rawFiles.filter((filePath) => {
      const key = path.resolve(filePath);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    if (format !== "claude_code" && format !== "codex") {
      consola.error(`Unsupported format: ${format}. Expected "claude_code" or "codex".`);
      process.exit(1);
    }

    let payloadFiles: ImportFilePayload[];
    try {
      payloadFiles = await Promise.all(
        files.map(async (filePath) => ({
          name: path.basename(filePath),
          content: await fs.readFile(filePath, "utf8"),
        })),
      );
    } catch (err) {
      consola.error(
        `Failed to read input files: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    let result: ImportResult;
    try {
      result = await daemonRequest<ImportResult>({
        action: "import",
        format,
        files: payloadFiles,
        options: {
          overwrite,
          skipIndex,
        },
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    const lines = [
      `${pc.green("✓")} Imported ${pc.bold(String(result.saved))} chat${result.saved === 1 ? "" : "s"}`,
      `  format=${result.format} · processed=${result.processed}/${result.total}`,
      `  skipped=${result.skipped} · errors=${result.errors} · index=${skipIndex ? "skipped" : "rebuilt"}`,
    ];

    consola.log(lines.join("\n"));
  },
});
