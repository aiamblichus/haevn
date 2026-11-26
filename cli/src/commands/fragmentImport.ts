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
  /** Symlinks named `.md` inside a directory: not read, since they are not the person's file */
  symlinks: number;
  /** For each file's name in the plan, the path to write an id to: where a symlink points */
  paths: Map<string, string>;
  /** For each file's name in the plan, the bytes that were read, so a write can tell they changed */
  bytes: Map<string, Buffer>;
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith(".md");

/**
 * Reads the files and directories named on the command line. A directory is read flat: its `.md`
 * files and nothing else, no descent, dot-files skipped. A file named outright that is not `.md`
 * is refused with a sentence that says to rename it. The bytes must be UTF-8, and a byte-order
 * mark is kept (the extension reads past it). A symlink named outright is read through, and an id
 * is written to what it points at; a symlink met inside a directory is counted and left.
 */
export async function collectFragmentFiles(inputs: string[]): Promise<FragmentInput> {
  const result: FragmentInput = {
    files: [],
    refused: [],
    notMarkdown: 0,
    symlinks: 0,
    paths: new Map(),
    bytes: new Map(),
  };
  const seen = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

  const add = async (filePath: string) => {
    const real = await fs.realpath(filePath);
    if (seen.has(real)) return;
    seen.add(real);
    const bytes = await fs.readFile(real);
    let content: string;
    try {
      content = decoder.decode(bytes);
    } catch {
      result.refused.push({ name: filePath, state: "unreadable", message: "not valid UTF-8" });
      return;
    }
    result.files.push({ name: filePath, content });
    result.paths.set(filePath, real);
    result.bytes.set(filePath, bytes);
  };

  for (const input of inputs) {
    const stat = await fs.stat(input);
    if (stat.isDirectory()) {
      const listed = (await fs.readdir(input, { withFileTypes: true })).filter(
        (entry) => !entry.name.startsWith("."),
      );
      result.symlinks += listed.filter(
        (entry) => entry.isSymbolicLink() && isMarkdown(entry.name),
      ).length;
      const entries = listed
        .filter((entry) => entry.isFile())
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

/** Why an id was not written to a file: said to the person, and kept out of the plan's states. */
class NotWritten extends Error {}

/**
 * Writes `content` over `target` by writing a temporary file beside it and renaming it over, so a
 * failure keeps the original. The file keeps its mode as it was (the umask does not apply). A
 * read-only file is left alone. The bytes are read once more just before the rename, and a file
 * that is not what was read is left alone too: it is being edited, and its edit wins.
 */
async function writeAtomically(target: string, content: string, original: Buffer): Promise<void> {
  const { mode } = await fs.stat(target);
  if ((mode & 0o222) === 0) throw new NotWritten("the file is read-only");
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { mode });
    await fs.chmod(temporary, mode & 0o7777);
    if (!(await fs.readFile(target)).equals(original)) {
      throw new NotWritten("the file changed after it was read: run the command again");
    }
    await fs.rename(temporary, target);
  } catch (err) {
    await fs.rm(temporary, { force: true });
    if (err instanceof NotWritten) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    throw new NotWritten(`the file could not be written${code ? ` (${code})` : ""}`);
  }
}

/**
 * Whether the `id:` line can go into the frontmatter of this file without breaking it: undefined
 * when it can, else the reason. A file with no block gets one of its own, and an empty or
 * comment-only block takes the line; a block whose first line is not `key: value` from the left
 * margin (a flow map, an indented block, a list) would no longer read as YAML with a line at
 * column 0 put in front of it.
 */
export function whyNoId(content: string): string | undefined {
  const text = content.startsWith("﻿") ? content.slice(1) : content;
  const open = /^---[ \t]*(\r?\n)/.exec(text);
  if (!open || !hasClosingFence(text, open[0].length)) return undefined;
  for (const raw of text.slice(open[0].length).split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trimEnd() === "---") return undefined;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    return KEY_LINE.test(line)
      ? undefined
      : "the frontmatter does not begin with a `key: value` line at the left margin, so no id: line was added; put one in by hand";
  }
  return undefined;
}

const KEY_LINE = /^(?:"[^"\n]*"|'[^'\n]*'|[^\s"'#{[\]\-?:,&*!|>%@`][^\n]*?)[ \t]*:(?:[ \t]|$)/;

export interface AssignedId {
  name: string;
  id: string;
}

/** What the CLI asks the extension: the plan of these files (`planOnly`), or the import of them. */
export type AskExtension = (files: ImportFilePayload[], planOnly: boolean) => Promise<ImportResult>;

const NOT_ADDED = "no id was added";

/**
 * Gives an id to each file the plan calls `no-id`, and returns what the import then says. The id
 * is decided after the rest of the checks: the files that lack an id are planned once more with
 * the id in them (in memory), and only a file that the plan then accepts gets the id on disk. A
 * file that would be refused for another reason (a blank body, a bad date), or whose frontmatter
 * the line cannot go into, or that cannot be written, is left as it is, stays `no-id` in the plan,
 * and says why. `--dry-run` runs the same decisions and writes nothing, so it shows what a real
 * run will do. After a real run the files in `input` carry the ids, and the import follows.
 */
export async function assignIds(
  input: Pick<FragmentInput, "files" | "paths" | "bytes">,
  ask: AskExtension,
  dryRun: boolean,
): Promise<{ result: ImportResult; assigned: AssignedId[] }> {
  const first = await ask(input.files, true);
  const byName = new Map(input.files.map((file) => [file.name, file]));
  const left = new Map<string, string>(); // file name -> why it was left without an id
  const candidates = new Map<string, { id: string; content: string }>();

  for (const entry of first.plan ?? []) {
    if (entry.state !== "no-id") continue;
    const file = byName.get(entry.name);
    if (!file) continue;
    const why = whyNoId(file.content);
    if (why) {
      left.set(entry.name, why);
      continue;
    }
    const id = randomUUID();
    candidates.set(entry.name, { id, content: assignId(file.content, id) });
  }

  // Plan the files as they will be, to decide which ids are worth writing
  let trial = first;
  if (candidates.size > 0) {
    trial = await ask(
      input.files.map((file) => {
        const candidate = candidates.get(file.name);
        return candidate ? { ...file, content: candidate.content } : file;
      }),
      true,
    );
  }
  const trialByName = new Map((trial.plan ?? []).map((entry) => [entry.name, entry]));
  const accepted: string[] = [];
  for (const name of candidates.keys()) {
    const planned = trialByName.get(name);
    if (planned && !REFUSED.has(planned.state)) accepted.push(name);
    else {
      left.set(
        name,
        `${NOT_ADDED}: the file would then be refused as ${planned?.state ?? "unreadable"}${planned?.message ? ` (${planned.message})` : ""}`,
      );
    }
  }

  const assigned: AssignedId[] = [];
  if (!dryRun) {
    for (const name of accepted) {
      const file = byName.get(name);
      const candidate = candidates.get(name);
      const target = input.paths.get(name);
      const original = input.bytes.get(name);
      if (!file || !candidate || !target || !original) {
        left.set(name, `${NOT_ADDED}: the file was not read from a path`);
        continue;
      }
      try {
        await writeAtomically(target, candidate.content, original);
        file.content = candidate.content;
        assigned.push({ name, id: candidate.id });
      } catch (err) {
        left.set(name, `${NOT_ADDED}: ${(err as Error).message}`);
      }
    }
  } else {
    for (const name of accepted) assigned.push({ name, id: candidates.get(name)?.id ?? "" });
  }

  // A dry run answers with the plan it just made; a real run imports the files as they are now
  const answer = dryRun ? trial : await ask(input.files, false);
  const plan = (answer.plan ?? []).map((entry) => {
    const why = left.get(entry.name);
    if (why) {
      const original = (first.plan ?? []).find((e) => e.name === entry.name);
      return { ...(original ?? entry), state: "no-id" as const, message: why };
    }
    if (dryRun && accepted.includes(entry.name)) return { ...entry, message: "would get a new id" };
    return entry;
  });
  return { result: { ...answer, plan }, assigned };
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
  local: { refused: LocalRefusal[]; notMarkdown: number; symlinks?: number },
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

  if (local.symlinks) {
    const n = local.symlinks;
    lines.push(
      `  ${plural(n, "symlink")} in a directory ${n === 1 ? "was" : "were"} not read: name a symlink on the command line to import what it points to`,
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
