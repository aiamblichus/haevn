/**
 * Logs command – read the extension's log buffer from the terminal (HVN-156).
 *
 * Usage:
 *   haevn logs                            # the newest 200 entries, oldest first
 *   haevn logs -n 50 --level warn         # the newest 50 entries at WARN and ERROR
 *   haevn logs --context background       # entries logged in the service worker
 *   haevn logs --match sync               # entries whose message, context or data has "sync"
 *   haevn logs -f json                    # the entries as the extension holds them, with data and stacks
 *
 * The buffer lives in the extension's service worker and keeps the recent entries of every context.
 * The filter is the one the extension's own log reader uses: --level keeps that level and the ones
 * above it (warn gives WARN and ERROR); --context is an exact name; --match is a case-insensitive
 * substring. A log line names a chat by its id and a provider by its name, with sizes and counts in
 * place of content (HVN-157); a provider's own short error message can still appear.
 * Exit code: 0 for an answer, also when nothing matches; 1 when the daemon or the extension fails.
 */

import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { toJsonString } from "../formatters/json";
import type { LogEntry, LogsOptions } from "../types";
import { flagText } from "../utils/args";
import { consola, pc, safeText } from "../utils/output";

const LOGS_DEFAULT_LIMIT = 200;
const LOGS_MAX_LIMIT = 1000;
const LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

export default defineCommand({
  meta: {
    name: "logs",
    description:
      "Read the extension's log, the newest entries last (ids, counts and sizes; no chat text)",
  },
  args: {
    limit: {
      type: "string",
      alias: "n",
      description: `Entries to show, the newest (default: ${LOGS_DEFAULT_LIMIT}, at most ${LOGS_MAX_LIMIT})`,
    },
    level: {
      type: "string",
      description:
        "Only entries at this level and above: debug, info, warn or error (warn gives WARN and ERROR)",
    },
    context: {
      type: "string",
      description:
        "Only entries logged in this context, exactly (background, popup, offscreen, ...)",
    },
    match: {
      type: "string",
      description: "Only entries whose message, context or data contains this text (any case)",
    },
    format: {
      type: "string",
      alias: "f",
      description:
        "Output format: text (default) or json (the entries as the extension holds them)",
      default: "text",
    },
  },
  async run({ args, rawArgs }) {
    const { format } = args;
    let options: LogsOptions;
    try {
      options = parseLogsOptions({
        limit: flagText(args.limit, rawArgs, ["--limit", "-n"]),
        level: flagText(args.level, rawArgs, ["--level"]),
        context: flagText(args.context, rawArgs, ["--context"]),
        match: flagText(args.match, rawArgs, ["--match"]),
      });
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    let entries: LogEntry[];
    try {
      entries = await daemonRequest<LogEntry[]>({ action: "logs", options });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      consola.error(
        /unknown action/i.test(text)
          ? "the extension does not know logs: it predates haevn logs, update the extension"
          : text,
      );
      process.exit(1);
    }

    if (format === "json") {
      consola.log(toJsonString(entries));
      return;
    }

    consola.log(formatLogText(entries));
  },
});

// ─── Argument parsing ────────────────────────────────────────────────────────

/**
 * Turn the flags into the request's options. The limit is a whole number from 1 to 1000 (200 when
 * absent); the level is one of the four names in any case; an absent or blank flag is left out.
 */
export function parseLogsOptions(input: {
  limit?: string;
  level?: string;
  context?: string;
  match?: string;
}): LogsOptions {
  const options: LogsOptions = { limit: parseLimit(input.limit) };
  if (input.level) options.level = parseLevel(input.level);
  if (input.context) options.context = input.context;
  if (input.match) options.match = input.match;
  return options;
}

function parseLimit(text: string | undefined): number {
  if (text === undefined || text === "") return LOGS_DEFAULT_LIMIT;
  const value = /^\d+$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
  if (!(value >= 1 && value <= LOGS_MAX_LIMIT)) {
    throw new Error(`--limit must be a whole number, 1 to ${LOGS_MAX_LIMIT} (got "${text}").`);
  }
  return value;
}

function parseLevel(text: string): (typeof LOG_LEVELS)[number] {
  const name = text.trim().toUpperCase();
  const level = LOG_LEVELS.find((known) => known === name);
  if (level === undefined) {
    throw new Error(`--level must be debug, info, warn or error (got "${text}").`);
  }
  return level;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** One line per entry, `timestamp level context message`, in the order given (oldest first). */
export function formatLogText(entries: LogEntry[]): string {
  if (entries.length === 0) {
    return "No log entries match.";
  }
  return entries.map(formatLogLine).join("\n");
}

function formatLogLine(entry: LogEntry): string {
  const when = Number.isFinite(entry.timestamp)
    ? new Date(entry.timestamp).toISOString()
    : String(entry.timestamp);
  const context = oneLine(entry.context);
  const message = oneLine(entry.message);
  return `${pc.dim(when)} ${paintLevel(entry.level)} ${pc.dim(context)} ${message}`;
}

function paintLevel(level: LogEntry["level"]): string {
  const label = level.padEnd(5);
  switch (level) {
    case "ERROR":
      return pc.red(label);
    case "WARN":
      return pc.yellow(label);
    default:
      return pc.dim(label);
  }
}

/** Safe to print, and on one line: a message with a line break in it shows the break as `\n`. */
function oneLine(text: string): string {
  return safeText(text).replace(/\n/g, "\\n");
}
