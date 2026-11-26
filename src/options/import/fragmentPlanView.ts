/**
 * What the fragment import dialog says about a plan and about what an import did (HVN-163,
 * slice 3). Pure: the words and the grouping, so a test can hold them. The design, with each
 * state's wording, is /project/haevn/product/design/fragment-import; the state names are the
 * plan's own, which the CLI prints too, so the docs, the CLI and the page say the same word.
 */

import {
  type FragmentPlanEntry,
  type FragmentState,
  REFUSED_STATES,
} from "../../providers/fragment/model";
import { INCREMENTAL_INDEX_MAX_CHATS } from "../../utils/importLimits";
import { FRAGMENT_IMPORT_MAX_BYTES, type GatheredFragments } from "./fragmentFiles";

/**
 * An error message as the middle of a sentence: its own full stop would double ours, and its
 * capital would stand mid-line ("Could not..." but not "IndexedDB..." or "HTTP...")
 */
export function inSentence(message: string): string {
  const bare = message.replace(/[.\s]+$/, "");
  // The first word only, and only when it is an ordinary one: not "IndexedDB" or "HTTP"
  return /^[A-Z][a-z]*(?=[\s,:;]|$)/.test(bare) ? bare[0].toLowerCase() + bare.slice(1) : bare;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const LABELS: Record<FragmentState, string> = {
  new: "New",
  changed: "Changed",
  unchanged: "Unchanged",
  "same-file": "Same file",
  "no-id": "No id",
  "bad-id": "Bad id",
  "bad-date": "Bad date",
  unreadable: "Unreadable",
  "duplicate-id": "Duplicate id",
};

/** The order the refusals are listed in (the CLI's order) */
const REFUSAL_ORDER: FragmentState[] = [
  "no-id",
  "bad-id",
  "bad-date",
  "unreadable",
  "duplicate-id",
];

export type GroupKey = "refused" | "new" | "changed" | "same-file" | "unchanged";

export interface PlanRow {
  name: string;
  state: FragmentState;
  label: string;
  /** "title · N turns · date" for a fragment that would be saved */
  meta?: string;
  /** Why a file is refused, or which file it repeats: the plan's own words */
  reason?: string;
  warnings: string[];
}

export interface PlanGroup {
  key: GroupKey;
  title: string;
  count: number;
  sentence: string;
  rows: PlanRow[];
}

export interface PlanView {
  groups: PlanGroup[];
  /** New, and changed when the changed are replaced */
  toImport: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  sameFileCount: number;
  refusedCount: number;
  /** New or changed files with something to say (an unchanged file is not written) */
  warnedCount: number;
  /** New or changed, with no title in the file */
  untitledCount: number;
}

/** The date as the plan gives it; an exact time (an ISO string) in the archive's own format */
function dateText(date: string | undefined): string | undefined {
  if (!date) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(date)) {
    const time = new Date(date);
    return Number.isNaN(time.getTime()) ? date : time.toLocaleString();
  }
  return date;
}

function metaOf(entry: FragmentPlanEntry): string {
  return [
    entry.title || "no title",
    entry.turns !== undefined ? plural(entry.turns, "turn") : undefined,
    dateText(entry.date),
  ]
    .filter(Boolean)
    .join(" · ");
}

function rowOf(entry: FragmentPlanEntry): PlanRow {
  const refused = REFUSED_STATES.has(entry.state);
  return {
    name: entry.name,
    state: entry.state,
    label: LABELS[entry.state],
    meta: entry.state === "new" || entry.state === "changed" ? metaOf(entry) : undefined,
    reason: refused || entry.state === "same-file" ? entry.message : undefined,
    warnings: entry.warnings.map((warning) => warning.message),
  };
}

/** Files with a warning first, the rest in the order the plan had them */
const warnedFirst = (rows: PlanRow[]) => [
  ...rows.filter((row) => row.warnings.length > 0),
  ...rows.filter((row) => row.warnings.length === 0),
];

export function describePlan(
  entries: FragmentPlanEntry[],
  options: { replace: boolean; allRefused?: boolean },
): PlanView {
  const rows = (pick: (state: FragmentState) => boolean) =>
    entries.filter((entry) => pick(entry.state)).map(rowOf);
  const refusedRows = REFUSAL_ORDER.flatMap((state) => rows((s) => s === state));
  const newRows = warnedFirst(rows((s) => s === "new"));
  const changedRows = warnedFirst(rows((s) => s === "changed"));
  const sameRows = rows((s) => s === "same-file");
  const unchangedRows = rows((s) => s === "unchanged");

  const untitled = (state: FragmentState) =>
    entries.filter((entry) => entry.state === state && !entry.title).length;
  const untitledNew = untitled("new");

  const groups: PlanGroup[] = [];
  if (refusedRows.length > 0) {
    groups.push({
      key: "refused",
      title: "Refused",
      count: refusedRows.length,
      sentence: options.allRefused
        ? "Fix them and choose them again."
        : "Left out. The other files do not wait for them.",
      rows: refusedRows,
    });
  }
  if (newRows.length > 0) {
    groups.push({
      key: "new",
      title: "New",
      count: newRows.length,
      sentence:
        untitledNew > 0
          ? `Added to the archive. ${untitledNew} ${untitledNew === 1 ? "has" : "have"} no title: shown as (Untitled) until metadata generation names ${untitledNew === 1 ? "it" : "them"}.`
          : "Added to the archive.",
      rows: newRows,
    });
  }
  if (changedRows.length > 0) {
    groups.push({
      key: "changed",
      title: "Changed",
      count: changedRows.length,
      sentence:
        "The file differs from what was imported from it. Its chat is replaced; a title or description the file gives is written over the archive's, and the rest is kept.",
      rows: changedRows,
    });
  }
  if (sameRows.length > 0) {
    groups.push({
      key: "same-file",
      title: "Same file",
      count: sameRows.length,
      sentence: "A copy, byte for byte, of another file in this import: imported once.",
      rows: sameRows,
    });
  }
  if (unchangedRows.length > 0) {
    groups.push({
      key: "unchanged",
      title: "Unchanged",
      count: unchangedRows.length,
      sentence: "Already in the archive as they are: nothing is written.",
      rows: unchangedRows,
    });
  }

  return {
    groups,
    toImport: newRows.length + (options.replace ? changedRows.length : 0),
    newCount: newRows.length,
    changedCount: changedRows.length,
    unchangedCount: unchangedRows.length,
    sameFileCount: sameRows.length,
    refusedCount: refusedRows.length,
    warnedCount: entries.filter(
      (entry) => (entry.state === "new" || entry.state === "changed") && entry.warnings.length > 0,
    ).length,
    untitledCount: untitledNew + untitled("changed"),
  };
}

// ─── What was given ──────────────────────────────────────────────────────────

/**
 * "486 files from recovered/", "12 files", "486 files from 3 folders", and for a drop of both
 * "6 files: 3 from walk-second/, 3 loose". Only the `.md` files are counted: they are the plan.
 */
export function planHeading(fileCount: number, gathered: GatheredFragments): string {
  const files = plural(fileCount, "file");
  const { folders, candidates } = gathered;
  if (folders.length === 0) return files;
  const loose = candidates.filter((candidate) => !candidate.folder).length;
  const inFolders = candidates.length - loose;
  const from = folders.length === 1 ? `${folders[0]}/` : `${folders.length} folders`;
  return loose > 0
    ? `${files}: ${inFolders} from ${from}, ${loose} loose`
    : `${files} from ${from}`;
}

/** What was left out, in a line: files that are not `.md`, and folders inside a folder */
export function leftOutLine(gathered: GatheredFragments): string {
  const parts: string[] = [];
  const { notMarkdown, notMarkdownNames, subfolders, folders } = gathered;
  if (notMarkdown > 0) {
    // Names only when every one of them is a loose file whose name the page has
    const named = notMarkdownNames.length === notMarkdown ? `: ${notMarkdownNames.join(", ")}` : "";
    parts.push(
      `${notMarkdown === 1 ? "1 file that is not .md was" : `${notMarkdown} files that are not .md were`} not read${named}.`,
    );
  }
  if (subfolders > 0) {
    const where = folders.length === 1 ? `${folders[0]}/` : "them";
    parts.push(
      `${subfolders === 1 ? "1 folder" : `${subfolders} folders`} inside ${where} ${subfolders === 1 ? "was" : "were"} not read: a folder is read flat.`,
    );
  }
  return parts.join(" ");
}

export interface Notice {
  title: string;
  body: string;
}

/**
 * What the zone says when nothing was found to read. `kept`: files were already there and this
 * drop added none of its own, so the plan stands (HVN-179).
 */
export function noMarkdownNotice(gathered: GatheredFragments, kept = false): Notice {
  const { notMarkdown, subfolders } = gathered;
  const parts: string[] = [];
  if (notMarkdown > 0) {
    parts.push(
      `${plural(notMarkdown, "file")} ${notMarkdown === 1 ? "was" : "were"} left out: a fragment is a .md file. If one of them is a fragment, rename it to .md.`,
    );
  }
  if (subfolders > 0) {
    parts.push(
      `${plural(subfolders, "folder")} inside ${subfolders === 1 ? "was" : "were"} not read: a folder is read flat.`,
    );
  }
  if (parts.length === 0 && gathered.folders.length > 0) parts.push("The folder is empty.");
  if (kept) parts.push("The files already here are as they were.");
  return { title: "No .md files here.", body: parts.join(" ") };
}

/** A read that threw (a folder that could not be listed, a file that vanished) */
/**
 * Chrome's own reason is not shown: its words for a file it may not open ("an attempt was made to
 * write to a file or directory…") contradict "Nothing was written". The caller logs it.
 */
export function readFailedNotice(): Notice {
  return {
    title: "The files could not be read.",
    body: "Chrome could not open a file or folder you chose: check that you can open it, then choose it again. Nothing was written.",
  };
}

export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function overLimitNotice(gathered: GatheredFragments, kept = false): Notice {
  const limit = FRAGMENT_IMPORT_MAX_BYTES / 1024 / 1024;
  const size = `${gathered.candidates.length} .md files hold ${megabytes(gathered.totalBytes)} of text, and one import takes at most ${limit} MB`;
  return {
    title: "Too much for one import.",
    // `kept`: the files already here, with these, are the set; these were not added
    body: kept
      ? `With these, the ${size}. They were not added; the files already here are kept. Choose fewer, or clear them and start again.`
      : `These ${size}. Choose fewer files at a time. Nothing was read.`,
  };
}

/** One line for the files that a drop or a pick replaced: the newer copy wins */
export function replacedLine(names: string[]): string {
  if (names.length === 0) return "";
  const shown = names.slice(0, 5).join(", ");
  const more = names.length > 5 ? ` and ${names.length - 5} more` : "";
  const what =
    names.length === 1
      ? "1 file replaced an earlier one"
      : `${names.length} files replaced earlier ones`;
  return `${what} of the same name: ${shown}${more}.`;
}

/** The operation that held the lock, as a person says it */
export function operationWords(operation: string): string {
  switch (operation) {
    case "bulkSync":
      return "bulk sync";
    case "import":
      return "an import";
    case "bulkExport":
      return "an export";
    case "providerHealth":
      return "a provider check";
    default:
      return operation;
  }
}

export function busyNotice(operation: string): Notice {
  return {
    title: "Not imported.",
    body: `Another operation is running (${operationWords(operation)}). Nothing was written. Try again when it ends.`,
  };
}

// ─── The `no-id` command ─────────────────────────────────────────────────────

/** A path as a shell takes it: plain when it has only safe characters, else in single quotes */
export function shellWord(path: string): string {
  return /^[A-Za-z0-9._/-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The command, and the folder it imports when it names a folder (else it names each file) */
export interface AssignIds {
  command: string;
  folder?: string;
}

/**
 * The command that gives each `no-id` file an id and imports. It names the folder when every one
 * of them came from the one folder that was given (the command imports the folder), else each
 * file by its name.
 */
export function assignIdsPlan(
  noId: { name: string; folder?: string }[],
  options: { folderIsEverything: boolean },
): AssignIds {
  const folders = new Set(noId.map((file) => file.folder));
  const [only] = folders;
  const folder = folders.size === 1 && options.folderIsEverything ? only : undefined;
  const paths = folder === undefined ? noId.map((file) => file.name) : [folder];
  return {
    command: `haevn import --format fragment --assign-ids ${paths.map(shellWord).join(" ")}`,
    folder,
  };
}

/** The two sentences around the command, in the words of its form (a folder, or the files) */
export function noIdWords(count: number, folder: string | undefined) {
  const cannot = "and this page cannot write one into your files. In a terminal, this gives";
  if (folder !== undefined) {
    return {
      lead: `${count === 1 ? "1 file has no id" : `${count} files have no id`}, ${cannot} ${count === 1 ? "it" : "each of them"} an id and imports the folder:`,
      where: `Run it in the folder that holds ${folder}/, or put the folder's full path in its place.`,
    };
  }
  return {
    lead: `${count === 1 ? "1 file has no id" : `${count} files have no id`}, ${cannot} ${count === 1 ? "it an id and imports it" : "each of them an id and imports them"}:`,
    where:
      count === 1
        ? "Run it in the folder that holds this file, or give its full path."
        : "Run it in the folder that holds these files, or give each its full path.",
  };
}

/** A fresh line to paste into a file's frontmatter; the page writes nothing to the file */
export const idLine = (id = crypto.randomUUID()) => `id: ${id}`;

/** The reason the plan gives for a file that has no `---` block at all (the parser's own words) */
export const isMissingFrontmatter = (reason: string | undefined) =>
  reason?.startsWith("no frontmatter") === true;

/** What to paste at the top of a file that has no frontmatter: the block, with the id in it */
export const idBlock = (id = crypto.randomUUID()) => `---\n${idLine(id)}\n---\n`;

/**
 * True when the service indexes the import in one pass at the end, so that search finds the chats
 * later. The batch counts every file it is given: the new, and the changed even when they are not
 * replaced (it loads them, then leaves them).
 */
export const indexesLater = (view: Pick<PlanView, "newCount" | "changedCount">) =>
  view.newCount + view.changedCount > INCREMENTAL_INDEX_MAX_CHATS;

// ─── What an import did ──────────────────────────────────────────────────────

/** The reply to an import that was not a dry run */
export interface FragmentImportReply {
  plan: FragmentPlanEntry[];
  imported?: {
    processed: number;
    saved: number;
    skipped: number;
    errors: number;
    failed?: { name: string; message: string }[];
    indexError?: string;
  };
}

export interface ImportOutcome {
  /** Fragments the import saved or failed to save (not the changed ones left as they are) */
  attempted: number;
  saved: number;
  newSaved: number;
  replaced: number;
  /** Changed files whose chats were left as they are (Replace was off) */
  leftAsIs: number;
  unchanged: number;
  /** Saved, with no title in the file */
  untitled: number;
  refused: number;
  failed: { name: string; message: string }[];
  indexError?: string;
}

/**
 * What the service says it did, read from the plan it made when it ran (the archive may have
 * changed since the first plan) and the batch's counts.
 */
export function describeOutcome(
  reply: FragmentImportReply,
  options: { replace: boolean },
): ImportOutcome {
  const failed = reply.imported?.failed ?? [];
  const failedNames = new Set(failed.map((file) => file.name));
  const of = (state: FragmentState) => reply.plan.filter((entry) => entry.state === state);
  const survives = (entry: FragmentPlanEntry) => !failedNames.has(entry.name);
  const changed = of("changed");
  const saved = reply.imported?.saved ?? 0;
  const newSaved = of("new").filter(survives);
  const replaced = options.replace ? changed.filter(survives) : [];
  return {
    attempted: saved + failed.length,
    saved,
    newSaved: newSaved.length,
    replaced: replaced.length,
    leftAsIs: options.replace ? 0 : changed.filter(survives).length,
    unchanged: of("unchanged").length,
    untitled: [...newSaved, ...replaced].filter((entry) => !entry.title).length,
    refused: reply.plan.filter((entry) => REFUSED_STATES.has(entry.state)).length,
    failed,
    indexError: reply.imported?.indexError,
  };
}
