/**
 * Health command – check that every web provider still works, in your own Chrome.
 *
 * Usage:
 *   haevn health                          # every web provider you are signed in to
 *   haevn health -p claude,chatgpt        # only these
 *   haevn health -n 3                     # three chats each (default 2, at most 5)
 *   haevn health -f json                  # the report as JSON
 *
 * The extension opens a tab on each provider's site, lists the chats, fetches the first few,
 * transforms them without saving anything or touching media, and checks the result. It is
 * read-only, and the report holds no chat text, title or id, so it can be pasted into a ticket.
 * Exit code: 0 when no provider failed or timed out, 1 when one did.
 */

import { defineCommand } from "citty";
import { daemonRequest } from "../daemon/client.js";
import { toJsonString } from "../formatters/json";
import type { HealthReport, HealthRow, HealthStatus } from "../types";
import { flagText, parseWholeNumber } from "../utils/args";
import { consola, pc, safeText } from "../utils/output";

/** The extension ends a run within 240 s; the daemon waits 270 s; this waits a little longer. */
const HEALTH_CLIENT_TIMEOUT_MS = 280_000;

export default defineCommand({
  meta: {
    name: "health",
    description: "Check that each web provider you are signed in to still syncs (read-only)",
  },
  args: {
    provider: {
      type: "string",
      alias: "p",
      description: "Comma-separated provider names (default: every web provider)",
    },
    chats: {
      type: "string",
      alias: "n",
      description: "Chats to check per provider, from the head of its list (default: 2, at most 5)",
    },
    timeout: {
      type: "string",
      description: "Seconds to give one provider (default: 40)",
    },
    format: {
      type: "string",
      alias: "f",
      description: "Output format (text, json)",
      default: "text",
    },
  },
  async run({ args, rawArgs }) {
    const { format } = args;
    let chats: number | undefined;
    let timeoutSeconds: number | undefined;
    let providers: string[] | undefined;
    try {
      const chatsText = flagText(args.chats, rawArgs, ["--chats", "-n"]);
      const timeoutText = flagText(args.timeout, rawArgs, ["--timeout"]);
      if (chatsText) chats = parseWholeNumber("chats", chatsText, 2, 1);
      if (chats !== undefined && chats > 5) {
        throw new Error(`--chats must be a whole number, 1 to 5 (got "${chatsText}").`);
      }
      if (timeoutText) timeoutSeconds = parseWholeNumber("timeout", timeoutText, 40, 5);
      if (timeoutSeconds !== undefined && timeoutSeconds > 120) {
        throw new Error(
          `--timeout must be a whole number of seconds, 5 to 120 (got "${timeoutText}").`,
        );
      }
      providers = parseProviders(args.provider);
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format !== "json") {
      // The run takes a while and opens tabs in Chrome; say so, on stderr, so a pipe stays clean.
      process.stderr.write(
        "  Checking providers in Chrome (tabs open on each site; up to 4 minutes)…\n",
      );
    }

    let report: HealthReport;
    try {
      report = await daemonRequest<HealthReport>(
        {
          action: "health",
          options: {
            ...(providers ? { providers } : {}),
            ...(chats !== undefined ? { chats } : {}),
            ...(timeoutSeconds !== undefined ? { timeoutMs: timeoutSeconds * 1000 } : {}),
          },
        },
        HEALTH_CLIENT_TIMEOUT_MS,
      );
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (format === "json") {
      consola.log(toJsonString(report));
    } else {
      consola.log(formatHealthText(report));
    }

    if (report.rows.some((row) => row.status === "fail" || row.status === "timeout")) {
      process.exit(1);
    }
  },
});

/** "claude, ChatGPT" -> ["claude", "chatgpt"]; undefined when the flag is absent or blank. */
export function parseProviders(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const names = input
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.length > 0 ? [...new Set(names)] : undefined;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: "ok",
  warn: "warn",
  fail: "FAIL",
  "not-signed-in": "not signed in",
  unreachable: "unreachable",
  timeout: "TIMEOUT",
  skipped: "skipped",
};

function paint(status: HealthStatus, text: string): string {
  switch (status) {
    case "ok":
      return pc.green(text);
    case "warn":
    case "unreachable":
      return pc.yellow(text);
    case "fail":
    case "timeout":
      return pc.red(text);
    default:
      return pc.dim(text);
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function signedIn(row: HealthRow): string {
  if (row.signedIn === true) return "yes";
  if (row.signedIn === false) return "no";
  return "?";
}

/**
 * The report as a table, then the findings under it. The text is built from counts, rule names and
 * the extension's own sentences; `safeText` is applied to those sentences all the same, because
 * what the sites send ends up in some of them.
 */
export function formatHealthText(report: HealthReport): string {
  const lines: string[] = [];
  const when = new Date(report.startedAt);
  lines.push(
    `${pc.bold("provider health")}  ${pc.dim(
      `extension ${report.extensionVersion}, ${Number.isNaN(when.getTime()) ? report.startedAt : when.toISOString()}, ${seconds(report.ms)}`,
    )}`,
  );
  lines.push("");

  const header = ["provider", "status", "signed in", "listed", "checked", "time"];
  const body = report.rows.map((row) => [
    row.provider,
    STATUS_LABEL[row.status],
    signedIn(row),
    row.listed === null ? "-" : String(row.listed),
    row.checked === 0 && row.listed === null ? "-" : String(row.checked),
    seconds(row.ms),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  lines.push(`  ${pc.dim(pad(header))}`);
  report.rows.forEach((row, i) => {
    const cells = body[i];
    const painted = cells.map((c, col) =>
      col === 1 ? paint(row.status, c.padEnd(widths[col])) : c.padEnd(widths[col]),
    );
    lines.push(`  ${painted.join("  ")}`);
  });

  const details: string[] = [];
  for (const row of report.rows) {
    for (const finding of row.findings) {
      const level = finding.level === "fail" ? pc.red("fail") : pc.yellow("warn");
      const where =
        finding.chats > 0 && row.checked > 0
          ? ` in ${finding.chats} of ${Math.max(row.checked, finding.chats)} chats`
          : "";
      details.push(
        `  ${row.provider.padEnd(widths[0])}  ${level}  ${finding.code} x${finding.count}${where}: ${safeText(finding.message)}`,
      );
    }
    if (row.note) {
      details.push(`  ${row.provider.padEnd(widths[0])}  ${pc.dim(`note: ${safeText(row.note)}`)}`);
    }
  }
  if (details.length > 0) {
    lines.push("");
    lines.push(...details);
  }

  const checked = report.rows.filter((r) => r.checked > 0).length;
  const failed = report.rows.filter((r) => r.status === "fail" || r.status === "timeout").length;
  const notChecked = report.rows.filter((r) =>
    ["not-signed-in", "unreachable", "skipped"].includes(r.status),
  ).length;
  lines.push("");
  lines.push(
    pc.dim(
      `  ${checked} of ${report.rows.length} providers checked, ${failed} failed, ${notChecked} not checked (not signed in, unreachable or skipped).`,
    ),
  );
  return lines.join("\n");
}
