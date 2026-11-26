/**
 * `haevn import --format fragment` (HVN-163): the CLI's side of the fragment import.
 *
 * The CLI has no YAML reader and imports nothing from the extension, so the plan is made there:
 * a dry run sends the files with `options.dryRun` and prints the plan that comes back. This file
 * reads the files (a directory is read flat, `.md` only), writes the ids of `--assign-ids`, and
 * says what the plan holds.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FragmentPlanEntry, ImportFilePayload, ImportResult } from "../types";
import { pc } from "../utils/output";

// ─── Reading the input ───────────────────────────────────────────────────────

/** A file the CLI refused before it asked the extension: the plan's own states, said here. */
export interface LocalRefusal {
  name: string;
  state: "unreadable";
  message: string;
}

export interface FragmentInput {
  files: ImportFilePayload[];
  refused: LocalRefusal[];
  /** Files of a directory that are not `.md`, and so were not read */
  notMarkdown: number;
  /** For each file's name in the plan, the path to write an id to */
  paths: Map<string, string>;
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith(".md");

/**
 * Reads the files and directories named on the command line. A directory is read flat: its `.md`
 * files and nothing else, no descent, dot-files skipped. A file named outright that is not `.md`
 * is refused with a sentence that says to rename it. The bytes must be UTF-8, and a byte-order
 * mark is kept (the extension reads past it).
 */
export async function collectFragmentFiles(inputs: string[]): Promise<FragmentInput> {
  const result: FragmentInput = { files: [], refused: [], notMarkdown: 0, paths: new Map() };
  const seen = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  const add = async (filePath: string) => {
    const key = path.resolve(filePath);
    if (seen.has(key)) return;
    seen.add(key);
    const bytes = await fs.readFile(filePath);
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      result.refused.push({ name: filePath, state: "unreadable", message: "not valid UTF-8" });
      return;
    }
    result.files.push({ name: filePath, content });
    result.paths.set(filePath, filePath);
  };

  for (const input of inputs) {
    const stat = await fs.stat(input);
    if (stat.isDirectory()) {
      const entries = (await fs.readdir(input, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort();
      for (const name of entries) {
        if (isMarkdown(name)) await add(path.join(input, name));
        else result.notMarkdown++;
      }
    } else if (isMarkdown(input)) {
      await add(input);
    } else {
      result.refused.push({
        name: input,
        state: "unreadable",
        message: `${path.basename(input)} is not a .md file: a fragment is Markdown, rename it to .md`,
      });
    }
  }
  return result;
}

// ─── --assign-ids ────────────────────────────────────────────────────────────

/** The text from `from` on holds a line that is `---`: the frontmatter's closing fence. */
function hasClosingFence(text: string, from: number): boolean {
  let pos = from;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const line = text.slice(pos, newline === -1 ? text.length : newline).replace(/\r$/, "");
    if (line.trimEnd() === "---") return true;
    if (newline === -1) return false;
    pos = newline + 1;
  }
  return false;
}

/**
 * Gives a file the id it lacks, and changes nothing else. A file that starts with a frontmatter
 * block gets the line `id: <uuid>` as that block's first line; any other gets a block holding only
 * that line in front, and its own bytes after it, untouched. The line ends as the file's first
 * line does. The same rule finds the frontmatter as the extension's parser, and a test holds the
 * two together.
 */
export function assignId(content: string, id: string): string {
  const bom = content.startsWith("﻿") ? "﻿" : "";
  const text = bom ? content.slice(1) : content;
  const open = /^---[ \t]*(\r?\n)/.exec(text);
  if (open && hasClosingFence(text, open[0].length)) {
    const head = open[0].length;
    return `${bom}${text.slice(0, head)}id: ${id}${open[1]}${text.slice(head)}`;
  }
  const eol = /^[^\n]*\r\n/.test(content) ? "\r\n" : "\n";
  return `---${eol}id: ${id}${eol}---${eol}${content}`;
}

/** Writes a file by writing a temporary one beside it and renaming it over, so a failure keeps the original. */
async function writeAtomically(filePath: string, content: string): Promise<void> {
  const mode = (await fs.stat(filePath)).mode;
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.rename(temporary, filePath);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    throw err;
  }
}

export interface AssignedId {
  name: string;
  id: string;
}

/**
 * Gives an id to each file the plan calls `no-id`, in `files` (so that the import that follows
 * carries it) and, unless `dryRun`, on disk. Returns what it gave, for the command to print.
 */
export async function assignIds(
  plan: FragmentPlanEntry[],
  files: ImportFilePayload[],
  paths: Map<string, string>,
  dryRun: boolean,
): Promise<AssignedId[]> {
  const assigned: AssignedId[] = [];
  const byName = new Map(files.map((file) => [file.name, file]));
  for (const entry of plan) {
    if (entry.state !== "no-id") continue;
    const file = byName.get(entry.name);
    const filePath = paths.get(entry.name);
    if (!file || !filePath) continue;
    const id = randomUUID();
    const content = assignId(file.content, id);
    if (!dryRun) {
      await writeAtomically(filePath, content);
      file.content = content;
    }
    assigned.push({ name: entry.name, id });
  }
  return assigned;
}

// ─── What the plan says ──────────────────────────────────────────────────────

export interface FragmentSummary {
  /** The lines to print, in order. */
  lines: string[];
  /** 1 when any file was refused, a chat failed to save, or the index was not brought up to date. */
  exitCode: 0 | 1;
}

const REFUSED = new Set(["no-id", "bad-id", "bad-date", "unreadable", "duplicate-id"]);

const STATE_ORDER = [
  "new",
  "changed",
  "unchanged",
  "same-file",
  "no-id",
  "bad-id",
  "bad-date",
  "unreadable",
  "duplicate-id",
] as const;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function entryLine(entry: FragmentPlanEntry): string {
  if (REFUSED.has(entry.state)) {
    return `  ${pc.red("✗")} ${entry.state.padEnd(12)} ${entry.name}${entry.message ? ` · ${entry.message}` : ""}`;
  }
  const detail = [
    entry.turns !== undefined ? plural(entry.turns, "turn") : "",
    entry.date ?? "",
    entry.message ?? "",
  ].filter(Boolean);
  return `  ${pc.green("·")} ${entry.state.padEnd(12)} ${entry.name}${detail.length ? ` · ${detail.join(" · ")}` : ""}`;
}

/**
 * Turns the plan (and what the import did with it) into the lines to print and the exit status.
 * A dry run lists every file; a real import lists the ones that need a word: refused, changed,
 * or with a warning. The last lines count files by state and warnings by kind.
 */
export function summarizeFragmentImport(
  result: ImportResult | undefined,
  local: { refused: LocalRefusal[]; notMarkdown: number },
  options: { dryRun: boolean; skipIndex: boolean },
): FragmentSummary {
  const plan: FragmentPlanEntry[] = [
    ...local.refused.map((r) => ({ ...r, warnings: [] })),
    ...(result?.plan ?? []),
  ];
  const lines: string[] = [];

  if (options.dryRun) lines.push(`${pc.yellow("!")} Dry run: nothing is written`);
  if (result && !options.dryRun) {
    const indexState = options.skipIndex
      ? "skipped"
      : result.indexError
        ? `failed (${result.indexError})`
        : result.processed === 0
          ? "untouched"
          : "updated";
    lines.push(
      result.saved > 0
        ? `${pc.green("✓")} Imported ${pc.bold(plural(result.saved, "fragment"))}`
        : `${pc.green("✓")} Nothing to import`,
      `  format=fragment · processed=${result.processed} · skipped=${result.skipped} · errors=${result.errors} · index=${indexState}`,
    );
  }

  for (const entry of plan) {
    const notable =
      options.dryRun ||
      REFUSED.has(entry.state) ||
      entry.state === "changed" ||
      entry.warnings.length > 0;
    if (!notable) continue;
    lines.push(entryLine(entry));
    for (const warning of entry.warnings) lines.push(`      ${pc.yellow("!")} ${warning.message}`);
  }

  if (local.notMarkdown > 0) {
    const n = local.notMarkdown;
    lines.push(
      `  ${plural(n, "file")} ${n === 1 ? "that is not .md was" : "that are not .md were"} not read`,
    );
  }

  const counts = new Map<string, number>();
  for (const entry of plan) counts.set(entry.state, (counts.get(entry.state) ?? 0) + 1);
  const refused = plan.filter((entry) => REFUSED.has(entry.state)).length;
  const warnings = new Map<string, number>();
  for (const entry of plan) {
    for (const warning of entry.warnings) {
      warnings.set(warning.code, (warnings.get(warning.code) ?? 0) + 1);
    }
  }
  const warningCount = [...warnings.values()].reduce((a, b) => a + b, 0);

  const byState = STATE_ORDER.filter((state) => counts.has(state) && !REFUSED.has(state))
    .map((state) => `${counts.get(state)} ${state}`)
    .concat([
      `${refused} refused`,
      `${warningCount} ${warningCount === 1 ? "warning" : "warnings"}`,
    ]);
  lines.push(`${plural(plan.length, "file")}: ${byState.join(" · ")}`);
  if (refused > 0) {
    const refusals = STATE_ORDER.filter((state) => REFUSED.has(state) && counts.has(state));
    lines.push(
      `  refused: ${refusals.map((state) => `${counts.get(state)} ${state}`).join(" · ")}`,
    );
  }
  if (warnings.size > 0) {
    lines.push(`  warnings: ${[...warnings].map(([code, n]) => `${code} ×${n}`).join(" · ")}`);
  }
  const untitled = (result?.plan ?? []).filter(
    (entry) => (entry.state === "new" || entry.state === "changed") && !entry.title,
  ).length;
  if (untitled > 0) {
    lines.push(
      `  ${plural(untitled, "file")} ${untitled === 1 ? "has" : "have"} no title: shown as (Untitled) until metadata generation names ${untitled === 1 ? "it" : "them"}`,
    );
  }

  const failed =
    !options.dryRun && result ? result.errors > 0 || Boolean(result.indexError) : false;
  return { lines, exitCode: refused > 0 || failed ? 1 : 0 };
}
