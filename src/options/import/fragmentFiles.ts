/**
 * Reading fragments on the archive page (HVN-163, slice 3). The page does what the CLI's
 * `collectFragmentFiles` does, so that a file imported from the page and then from a terminal is
 * `unchanged`, not `changed`: a folder is read flat, `.md` only (any case), dot-files skipped and
 * not counted, the others counted; the text is read as strict UTF-8 with the byte-order mark kept.
 * Nothing here talks to the extension: the plan is asked for with what `readFragmentFiles` returns.
 *
 * The design is /project/haevn/product/design/fragment-import.
 */

import type { FragmentFile, FragmentPlanEntry } from "../../providers/fragment";

/** One import takes at most this much text: it travels in one message, under Chrome's 64 MiB */
export const FRAGMENT_IMPORT_MAX_BYTES = 16 * 1024 * 1024;

/** How many names of left-out files the page says */
const LEFT_OUT_NAMES = 5;

/** What the person gave: a loose file, or a folder and what lies directly in it */
export type FragmentSource =
  | { kind: "file"; file: File }
  | { kind: "folder"; name: string; entries: FolderEntry[] };

/** An entry of a folder: a file, or (no `file`) a folder inside it */
export interface FolderEntry {
  name: string;
  file?: File;
}

export interface FragmentCandidate {
  /** What the plan calls the file: unique among the candidates, so a result maps to one file */
  name: string;
  file: File;
  /** The folder it came from; undefined for a loose file */
  folder?: string;
}

export interface GatheredFragments {
  /** The `.md` files to read, in the order they are sent */
  candidates: FragmentCandidate[];
  /** The names of the folders given, in order */
  folders: string[];
  /** Loose files given (every one, whether `.md` or not) */
  looseFiles: number;
  /** Files that are not `.md`, and so were not read */
  notMarkdown: number;
  /** Up to five of the names of the loose files that are not `.md` */
  notMarkdownNames: string[];
  /** Folders inside a given folder: not read, since a folder is read flat */
  subfolders: number;
  /** The size of the `.md` files together, from `File.size` */
  totalBytes: number;
}

const isMarkdown = (name: string) => name.toLowerCase().endsWith(".md");

/** "a.md" is taken: "a (2).md", then "a (3).md", until the name is free */
export function freeName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${extension}`;
    if (!taken.has(next)) return next;
  }
}

/**
 * Decides what is read, from what was given, and names each file. No file is opened. A folder's
 * files are in name order (the CLI's order); the folders and loose files keep the order given.
 */
export function gatherFragmentSources(sources: FragmentSource[]): GatheredFragments {
  const found: FragmentCandidate[] = [];
  const folders: string[] = [];
  // Two folders of one name (dropped from two places) would give `notes/1.md` twice: the plan, the
  // rows and the batch's `failed` all go by name, so the second is called `notes (2)`
  const folderNames = new Set<string>();
  const looseNames = new Set<string>();
  const notMarkdownNames: string[] = [];
  let looseFiles = 0;
  let notMarkdown = 0;
  let subfolders = 0;

  for (const source of sources) {
    if (source.kind === "file") {
      looseFiles++;
      if (isMarkdown(source.file.name)) {
        const name = freeName(source.file.name, looseNames);
        looseNames.add(name);
        found.push({ name, file: source.file });
      } else {
        notMarkdown++;
        if (notMarkdownNames.length < LEFT_OUT_NAMES) notMarkdownNames.push(source.file.name);
      }
      continue;
    }
    const label = freeName(source.name, folderNames);
    folderNames.add(label);
    folders.push(label);
    const listed = source.entries.filter((entry) => !entry.name.startsWith("."));
    subfolders += listed.filter((entry) => !entry.file).length;
    const files = listed
      .filter((entry): entry is FolderEntry & { file: File } => Boolean(entry.file))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of files) {
      if (isMarkdown(entry.name)) {
        found.push({ name: entry.name, file: entry.file, folder: label });
      } else {
        notMarkdown++;
      }
    }
  }

  // One folder, nothing else: the folder is named once, in the heading. Anything else: the folder
  // goes in the name, so that two files of one name in two folders stay apart.
  const bare = folders.length === 1 && looseFiles === 0;
  const candidates = bare
    ? found
    : found.map((c) => (c.folder ? { ...c, name: `${c.folder}/${c.name}` } : c));
  return {
    candidates,
    folders,
    looseFiles,
    notMarkdown,
    notMarkdownNames,
    subfolders,
    totalBytes: candidates.reduce((sum, c) => sum + c.file.size, 0),
  };
}

/**
 * What the person has given so far, with one more drop or pick added (HVN-179). A file of the same
 * name as one already there replaces it, newer wins: a loose file by its name, a file of a folder
 * by the folder's name and its own, so that dropping a folder again with one file edited replaces
 * that file and keeps the others. Two folders of one name in the same drop are two folders (the
 * second is called `notes (2)`); across drops the name is all there is to tell them by, so the
 * same name is the same folder. Nothing is opened.
 *
 * `replaced` names the `.md` files that were replaced, folder-qualified (`notes/1.md`).
 */
export function addSources(
  current: FragmentSource[],
  added: FragmentSource[],
): { sources: FragmentSource[]; replaced: string[] } {
  const sources: FragmentSource[] = current.map((source) =>
    source.kind === "folder" ? { ...source, entries: [...source.entries] } : source,
  );
  const replaced: string[] = [];
  const foldersInThisDrop = new Set<string>();
  const looseInThisDrop = new Set<string>();

  for (const source of added) {
    if (source.kind === "file") {
      const name = source.file.name;
      const at = looseInThisDrop.has(name)
        ? -1
        : sources.findIndex((s) => s.kind === "file" && s.file.name === name);
      looseInThisDrop.add(name);
      if (at === -1) {
        sources.push(source);
      } else {
        sources[at] = source;
        if (isMarkdown(name) && !replaced.includes(name)) replaced.push(name);
      }
      continue;
    }

    const second = foldersInThisDrop.has(source.name);
    foldersInThisDrop.add(source.name);
    const at = second
      ? -1
      : sources.findIndex((s) => s.kind === "folder" && s.name === source.name);
    if (at === -1) {
      const taken = new Set(sources.flatMap((s) => (s.kind === "folder" ? [s.name] : [])));
      sources.push({ ...source, name: second ? freeName(source.name, taken) : source.name });
      continue;
    }
    const target = sources[at];
    if (target.kind !== "folder") continue;
    for (const entry of source.entries) {
      const same = target.entries.findIndex((existing) => existing.name === entry.name);
      if (same === -1) {
        target.entries.push(entry);
        continue;
      }
      const qualified = `${target.name}/${entry.name}`;
      const wasFile = target.entries[same].file !== undefined;
      if (wasFile && entry.file && isMarkdown(entry.name) && !entry.name.startsWith(".")) {
        if (!replaced.includes(qualified)) replaced.push(qualified);
      }
      target.entries[same] = entry;
    }
  }
  return { sources, replaced };
}

/** True when the `.md` files together are more than one import takes */
export const overLimit = (gathered: GatheredFragments) =>
  gathered.totalBytes > FRAGMENT_IMPORT_MAX_BYTES;

/**
 * A folder chosen with the picker (`<input webkitdirectory>`): the browser gives every file under
 * it, each with a `webkitRelativePath` of `folder/name` or `folder/sub/.../name`. Only the first
 * is read; the others say there is a folder inside.
 */
export function sourceFromFolderPick(files: File[]): FragmentSource | undefined {
  const entries = new Map<string, FolderEntry>();
  let folder: string | undefined;
  for (const file of files) {
    const parts = file.webkitRelativePath.split("/");
    if (parts.length < 2) continue;
    folder ??= parts[0];
    if (parts.length === 2) {
      entries.set(parts[1], { name: parts[1], file });
    } else if (!entries.has(parts[1])) {
      entries.set(parts[1], { name: parts[1] });
    }
  }
  return folder === undefined
    ? undefined
    : { kind: "folder", name: folder, entries: [...entries.values()] };
}

// ─── A drop ──────────────────────────────────────────────────────────────────

/** What a drop's items hold, taken in the drop event itself: they are gone after it returns */
export interface DroppedItem {
  file: File | null;
  entry: FileSystemEntry | null;
}

/** Takes the items of a drop. Must run in the event handler, before any `await`. */
export function takeDroppedItems(data: DataTransfer): DroppedItem[] {
  return Array.from(data.items)
    .filter((item) => item.kind === "file")
    .map((item) => ({
      file: item.getAsFile(),
      entry: typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null,
    }));
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        // A directory reader answers in batches (about a hundred) and ends with an empty one
        if (batch.length === 0) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

const fileOf = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

/** The sources a drop holds: a dropped folder is listed (one level), a dropped file is as it is */
export async function sourcesFromDrop(items: DroppedItem[]): Promise<FragmentSource[]> {
  const sources: FragmentSource[] = [];
  for (const { file, entry } of items) {
    if (entry?.isDirectory) {
      const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
      const entries: FolderEntry[] = [];
      for (const child of children) {
        entries.push(
          child.isFile
            ? { name: child.name, file: await fileOf(child as FileSystemFileEntry) }
            : { name: child.name },
        );
      }
      sources.push({ kind: "folder", name: entry.name, entries });
    } else if (file) {
      sources.push({ kind: "file", file });
    }
  }
  return sources;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

export interface ReadFragments {
  /** The files that are text, to ask the plan for */
  files: FragmentFile[];
  /** The files that are not UTF-8: refused here, and part of the plan all the same */
  refused: FragmentPlanEntry[];
}

/** What was read of a file: its text, or null when it is not UTF-8. Kept per `File`, so that a set
 *  that grows is not read again from the start (HVN-179). */
export type ReadCache = WeakMap<File, string | null>;

/**
 * Reads the text of each file, as the CLI does: strict UTF-8, byte-order mark kept (`file.text()`
 * would replace bad bytes, and hash differently). `onProgress` is told how many are read.
 * `isCancelled` is asked between files: a cancelled read returns nothing. A file already in
 * `cache` is not opened again.
 */
export async function readFragmentFiles(
  gathered: GatheredFragments,
  hooks: { onProgress?: (read: number) => void; isCancelled?: () => boolean } = {},
  cache?: ReadCache,
): Promise<ReadFragments | undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const result: ReadFragments = { files: [], refused: [] };
  let read = 0;
  for (const candidate of gathered.candidates) {
    if (hooks.isCancelled?.()) return undefined;
    let text = cache?.get(candidate.file);
    if (text === undefined) {
      const bytes = await candidate.file.arrayBuffer();
      if (hooks.isCancelled?.()) return undefined;
      try {
        text = decoder.decode(bytes);
      } catch {
        text = null;
      }
      cache?.set(candidate.file, text);
    }
    if (text !== null) {
      result.files.push({ name: candidate.name, content: text });
    } else {
      result.refused.push({
        name: candidate.name,
        state: "unreadable",
        message: "not valid UTF-8",
        warnings: [],
      });
    }
    read++;
    hooks.onProgress?.(read);
    // Let the page draw the bar: a long folder would otherwise show nothing until it is read
    if (read % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return result;
}
