/**
 * Import command - import local transcript artifacts into HAEVN archive.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import type { ImportFilePayload, ImportFormat, ImportResult } from "../types";
import { consola, pc } from "../utils/output";
import {
  assignIds,
  collectFragmentFiles,
  type FragmentInput,
  summarizeFragmentImport,
} from "./fragmentImport";

// ─── Format metadata ─────────────────────────────────────────────────────────

const BINARY_FORMATS = new Set<ImportFormat>(["image", "video"]);

const SUPPORTED_FORMATS: ImportFormat[] = [
  "claude_code",
  "codex",
  "pi",
  "openrouter",
  "haevn_json",
  "markdown",
  "fragment",
  "image",
  "video",
];

const IMAGE_MIMES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const VIDEO_MIMES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
};

const WARN_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectMimeType(filePath: string, format: "image" | "video"): string {
  const ext = path.extname(filePath).toLowerCase();
  const mimes = format === "image" ? IMAGE_MIMES : VIDEO_MIMES;
  const mime = mimes[ext];
  if (!mime) {
    const valid = Object.keys(mimes).join(", ");
    throw new Error(`Unsupported ${format} extension "${ext}". Supported: ${valid}`);
  }
  return mime;
}

function buildMediaChat(
  buffer: Buffer,
  sha256: string,
  filePath: string,
  mimeType: string,
  mediaKind: "image" | "video",
  prompt: string | undefined,
): string {
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const title = path.basename(filePath, path.extname(filePath));
  const base64 = buffer.toString("base64");

  const responsePart =
    mediaKind === "image"
      ? {
          part_kind: "image-response",
          content: { kind: "binary", data: base64, media_type: mimeType },
        }
      : {
          part_kind: "video-response",
          content: { kind: "binary", data: base64, media_type: mimeType },
        };

  const modelMessages: unknown[] = [];
  if (prompt) {
    modelMessages.push({
      kind: "request",
      parts: [{ part_kind: "user-prompt", content: prompt, timestamp: iso }],
    });
  }
  modelMessages.push({
    kind: "response",
    parts: [responsePart],
    timestamp: iso,
    model_name: "unknown",
  });

  const chat = {
    id: sha256,
    source: "unknown",
    sourceId: sha256,
    title,
    models: [],
    params: {},
    tags: [],
    currentId: "msg_0",
    messages: {
      msg_0: {
        id: "msg_0",
        chatId: sha256,
        childrenIds: [],
        model: "unknown",
        done: true,
        timestamp: now,
        message: modelMessages,
      },
    },
    timestamp: now,
    lastSyncedTimestamp: now,
    syncStatus: "synced",
    checksum: "",
    deleted: 0,
  };

  return JSON.stringify(chat);
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export interface ImportSummary {
  /** The lines to print, in order. */
  lines: string[];
  /** 1 when no chat was found, or the chats were saved but the search index was not brought up to date; else 0. */
  exitCode: 0 | 1;
}

/**
 * Turn the daemon's import result into the lines to print and the exit status.
 */
export function summarizeImport(
  result: ImportResult,
  options: { format: ImportFormat; skipIndex: boolean },
): ImportSummary {
  const { format, skipIndex } = options;
  // A file can hold no chat at all (an OpenRouter export whose chatrooms are all empty).
  if (result.total === 0) {
    return {
      lines: [
        `${pc.yellow("!")} No chats found in the input; nothing was imported`,
        `  format=${format}`,
      ],
      exitCode: 1,
    };
  }
  const indexState = skipIndex
    ? "skipped"
    : result.indexError
      ? `failed (${result.indexError})`
      : "updated";
  const lines = [
    `${pc.green("✓")} Imported ${pc.bold(String(result.saved))} chat${result.saved === 1 ? "" : "s"}`,
    `  format=${format} · processed=${result.processed}/${result.total}`,
    `  skipped=${result.skipped} · errors=${result.errors} · index=${indexState}`,
  ];

  return { lines, exitCode: result.indexError ? 1 : 0 };
}

// ─── Fragments ───────────────────────────────────────────────────────────────

async function runFragmentImport(
  inputs: string[],
  options: { overwrite: boolean; skipIndex: boolean; dryRun: boolean; assign: boolean },
): Promise<void> {
  const { overwrite, skipIndex, dryRun, assign } = options;

  let input: FragmentInput;
  try {
    input = await collectFragmentFiles(inputs);
  } catch (err) {
    consola.error(
      `Failed to read input files: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  const ask = (files: ImportFilePayload[], planOnly: boolean) =>
    daemonRequest<ImportResult>({
      action: "import",
      format: "fragment",
      files,
      options: { overwrite, skipIndex, dryRun: planOnly },
    });

  let result: ImportResult | undefined;
  try {
    if (input.files.length > 0) {
      if (assign) {
        // The ids are decided after the plan's other checks, so a file that could not be imported
        // anyway is left as it is; a dry run decides the same and writes nothing
        const outcome = await assignIds(input, ask, dryRun);
        for (const { name } of outcome.assigned) {
          consola.log(
            `  ${pc.cyan("id")} ${dryRun ? "would write an id to" : "wrote an id to"} ${name}`,
          );
        }
        result = outcome.result;
      } else {
        result = await ask(input.files, dryRun);
      }
    }
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const summary = summarizeFragmentImport(result, input, { dryRun, skipIndex });
  if (!result && input.refused.length === 0) {
    consola.error("No .md files found in the input; nothing was imported");
    process.exit(1);
  }
  consola.log(summary.lines.join("\n"));
  if (summary.exitCode !== 0) process.exit(summary.exitCode);
}

// ─── Command ─────────────────────────────────────────────────────────────────

export default defineCommand({
  meta: {
    name: "import",
    description: "Import local transcript or media artifacts into HAEVN archive",
  },
  args: {
    format: {
      type: "string",
      required: true,
      description: `Input format (${SUPPORTED_FORMATS.join("|")})`,
    },
    file: {
      type: "positional",
      description: "Input file path (first file)",
      required: true,
    },
    prompt: {
      type: "string",
      description: "Prompt text to attach to imported image or video (optional)",
    },
    "no-overwrite": {
      type: "boolean",
      description: "Skip chats that already exist (default is overwrite)",
      default: false,
    },
    "skip-index": {
      type: "boolean",
      description: "Save without indexing for search (the next index rebuild picks the chats up)",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Fragments only: say what each file would do, and write nothing",
      default: false,
    },
    "assign-ids": {
      type: "boolean",
      description:
        "Fragments only: write a fresh id into each file that has none (this changes your files)",
      default: false,
    },
  },
  async run({ args }) {
    const format = args.format as ImportFormat;
    const overwrite = !args["no-overwrite"];
    const skipIndex = args["skip-index"];
    const prompt = args.prompt as string | undefined;
    const dryRun = args["dry-run"] === true;
    const assign = args["assign-ids"] === true;
    const extraPositional = (args._ || []).map(String).filter(Boolean);
    const rawFiles = [String(args.file), ...extraPositional].filter(Boolean);

    // Deduplicate file paths
    const seen = new Set<string>();
    const files = rawFiles.filter((filePath) => {
      const key = path.resolve(filePath);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!SUPPORTED_FORMATS.includes(format)) {
      consola.error(
        `Unsupported format: ${format}. Expected one of: ${SUPPORTED_FORMATS.join(", ")}`,
      );
      process.exit(1);
    }

    // A flag that would be ignored must not look as if it had been obeyed: --dry-run would import
    if ((dryRun || assign) && format !== "fragment") {
      consola.error(`--dry-run and --assign-ids are only for --format fragment, not "${format}"`);
      process.exit(1);
    }

    if (format === "fragment") {
      await runFragmentImport(files, { overwrite, skipIndex, dryRun, assign });
      return;
    }

    if (prompt && !BINARY_FORMATS.has(format)) {
      consola.warn(`--prompt is only used for image/video imports; ignored for format "${format}"`);
    }

    // ── Read files ────────────────────────────────────────────────────────────

    let payloadFiles: ImportFilePayload[];
    // Wire format: image/video are synthesized into haevn_json on the CLI side
    let wireFormat: ImportFormat = format;

    try {
      if (BINARY_FORMATS.has(format)) {
        const mediaKind = format as "image" | "video";
        wireFormat = "haevn_json";

        payloadFiles = await Promise.all(
          files.map(async (filePath) => {
            const buffer = await fs.readFile(filePath);

            if (buffer.length > WARN_SIZE_BYTES) {
              consola.warn(
                `${path.basename(filePath)} is ${(buffer.length / 1024 / 1024).toFixed(1)} MB — large files may be slow to transfer`,
              );
            }

            const sha256 = createHash("sha256")
              .update(buffer)
              .update("\0")
              .update(prompt ?? "")
              .digest("hex");
            const mimeType = detectMimeType(filePath, mediaKind);
            const content = buildMediaChat(buffer, sha256, filePath, mimeType, mediaKind, prompt);
            return { name: path.basename(filePath), content };
          }),
        );
      } else {
        payloadFiles = await Promise.all(
          files.map(async (filePath) => ({
            name: path.basename(filePath),
            content: await fs.readFile(filePath, "utf8"),
          })),
        );
      }
    } catch (err) {
      consola.error(
        `Failed to read input files: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }

    // ── Send to extension via daemon ──────────────────────────────────────────

    let result: ImportResult;
    try {
      result = await daemonRequest<ImportResult>({
        action: "import",
        format: wireFormat,
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

    const summary = summarizeImport(result, { format, skipIndex });
    consola.log(summary.lines.join("\n"));
    // The chats are saved, but they will not be found by search until the index is rebuilt.
    if (summary.exitCode !== 0) process.exit(summary.exitCode);
  },
});
