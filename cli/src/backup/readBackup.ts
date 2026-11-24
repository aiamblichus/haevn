/**
 * Reading a backup directory before anything is restored from it (HVN-137; architecture/backup-restore,
 * "Restore: the algorithm"). The manifest says what the directory is, `index.jsonl` is the authority
 * for which files belong to which chat, and every file's size and SHA-256 are checked against it
 * before the first byte is sent: a damaged backup is refused with nothing written.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { failed } from "../utils/exit.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  INDEX_FILE,
  type IndexEntry,
  isSafeFileName,
  MANIFEST_FILE,
  type Manifest,
  RECORD_PREFIX,
  RECORD_VERSION,
} from "./layout.js";

export interface BackupContents {
  /** The directory, absolute. */
  dir: string;
  manifest: Manifest;
  entries: IndexEntry[];
}

/** The most of a record's first line that is read to learn when the chat was last synced. */
const HEADER_LIMIT = 32 * 1024 * 1024;

/** The manifest and the index of a backup, checked for shape. Reads no chat and no media file. */
export function readBackup(directory: string): BackupContents {
  const dir = path.resolve(directory);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw failed(`${dir} does not exist`);
  }
  if (!stat.isDirectory()) throw failed(`${dir} is not a directory`);

  let manifestText: string;
  try {
    manifestText = fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8");
  } catch {
    throw failed(
      `${dir} has no ${MANIFEST_FILE}: it is not a complete haevn backup (a ${path.basename(dir)}.partial is an unfinished one)`,
    );
  }
  const manifest = parseManifest(manifestText, dir);

  let indexText: string;
  try {
    indexText = fs.readFileSync(path.join(dir, INDEX_FILE), "utf8");
  } catch {
    throw failed(`${dir} has a ${MANIFEST_FILE} but no ${INDEX_FILE}: the backup is damaged`);
  }
  const entries = parseIndex(indexText, dir);

  if (entries.length !== manifest.chats) {
    throw failed(
      `the backup is damaged: ${MANIFEST_FILE} says ${manifest.chats} chats and ${INDEX_FILE} lists ${entries.length}`,
    );
  }
  const mediaFiles = entries.reduce((sum, entry) => sum + entry.media.length, 0);
  if (mediaFiles !== manifest.mediaFiles) {
    throw failed(
      `the backup is damaged: ${MANIFEST_FILE} says ${manifest.mediaFiles} media files and ${INDEX_FILE} lists ${mediaFiles}`,
    );
  }
  return { dir, manifest, entries };
}

/** The entries of `ids`, in the index's order; every id must be in the backup. No ids: all of them. */
export function selectChats(contents: BackupContents, ids: string[]): IndexEntry[] {
  if (ids.length === 0) return contents.entries;
  const wanted = new Set(ids);
  const missing = ids.filter((id) => !contents.entries.some((entry) => entry.id === id));
  if (missing.length > 0) {
    throw failed(
      `${missing.length === 1 ? "chat" : "chats"} ${missing.map((id) => JSON.stringify(id)).join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not in the backup`,
    );
  }
  return contents.entries.filter((entry) => wanted.has(entry.id));
}

/** The path of a file the index names. `parseIndex` has already kept it inside the backup. */
export function fileOf(contents: BackupContents, relative: string): string {
  return path.join(contents.dir, relative);
}

export interface Verified {
  /** Files checked, and bytes read. */
  files: number;
  bytes: number;
  /**
   * `lastSyncedTimestamp` from the header of the record of each chat `wantHeader` asked for;
   * null when the header is too big to read or does not parse.
   */
  syncedAt: Map<string, number | null>;
}

/**
 * Check the files of `entries` against the index: each must be there, at the size and with the
 * SHA-256 it says, and each record must start as a version-1 record does. Every problem is
 * collected, so a damaged backup is described once; any problem ends the run (1), nothing written.
 */
export async function verifyFiles(
  contents: BackupContents,
  entries: IndexEntry[],
  options: {
    wantHeader?: (entry: IndexEntry) => boolean;
    signal?: AbortSignal;
    log?: (line: string) => void;
  } = {},
): Promise<Verified> {
  const problems: string[] = [];
  const verified: Verified = { files: 0, bytes: 0, syncedAt: new Map() };

  const check = async (
    relative: string,
    expected: { bytes: number; sha256: string },
    headBytes: number,
  ): Promise<Buffer | null> => {
    options.signal?.throwIfAborted();
    const file = fileOf(contents, relative);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      problems.push(`${relative} is missing`);
      return null;
    }
    if (size !== expected.bytes) {
      problems.push(`${relative} is ${size} bytes and ${INDEX_FILE} says ${expected.bytes}`);
      return null;
    }
    const read = await hashFile(file, headBytes, options.signal);
    verified.files += 1;
    verified.bytes += read.bytes;
    if (read.sha256 !== expected.sha256) {
      problems.push(`${relative} does not match its SHA-256 in ${INDEX_FILE}`);
      return null;
    }
    return read.head;
  };

  for (const [n, entry] of entries.entries()) {
    if (n > 0 && n % 250 === 0) options.log?.(`checked ${n} of ${entries.length} chats`);
    const wantsHeader = options.wantHeader?.(entry) === true;
    const head = await check(entry.file, entry, wantsHeader ? HEADER_LIMIT : RECORD_PREFIX.length);
    if (head !== null) {
      if (!head.toString("utf8", 0, RECORD_PREFIX.length).startsWith(RECORD_PREFIX)) {
        problems.push(`${entry.file} is not a version ${RECORD_VERSION} chat record`);
      } else if (wantsHeader) {
        verified.syncedAt.set(entry.id, lastSyncedOf(head));
      }
    }
    for (const media of entry.media) {
      await check(`${entry.mediaDir}/${media.name}`, media, 0);
    }
  }

  if (problems.length > 0) {
    const shown = problems.slice(0, 5).map((problem) => `\n  ${problem}`);
    const more = problems.length > 5 ? `\n  and ${problems.length - 5} more` : "";
    throw failed(
      `the backup is damaged, and nothing was written: ${problems.length} ${
        problems.length === 1 ? "file does" : "files do"
      } not match ${INDEX_FILE}${shown.join("")}${more}`,
    );
  }
  return verified;
}

// ─── Internals ────────────────────────────────────────────────────────────────

function parseManifest(text: string, dir: string): Manifest {
  let value: Partial<Record<keyof Manifest, unknown>>;
  try {
    value = JSON.parse(text) as typeof value;
  } catch {
    throw failed(`${path.join(dir, MANIFEST_FILE)} is not JSON: the backup is damaged`);
  }
  if (value === null || typeof value !== "object" || value.format !== BACKUP_FORMAT) {
    throw failed(`${dir} is not a haevn backup (its ${MANIFEST_FILE} has another format)`);
  }
  if (typeof value.version !== "number") {
    throw failed(`the ${MANIFEST_FILE} of ${dir} has no version: the backup is damaged`);
  }
  if (value.version > BACKUP_VERSION) {
    throw failed(
      `${dir} is a version ${value.version} backup and this CLI reads version ${BACKUP_VERSION}: update the CLI`,
    );
  }
  if (value.version !== BACKUP_VERSION) {
    throw failed(
      `${dir} is a version ${String(value.version)} backup and this CLI reads version ${BACKUP_VERSION}`,
    );
  }
  const count = (field: "chats" | "mediaFiles" | "bytes" | "dbSchema"): number => {
    const number = value[field];
    if (typeof number !== "number" || !Number.isInteger(number) || number < 0) {
      throw failed(`the ${MANIFEST_FILE} of ${dir} has no valid "${field}": the backup is damaged`);
    }
    return number;
  };
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
    haevnVersion: typeof value.haevnVersion === "string" ? value.haevnVersion : "unknown",
    dbSchema: count("dbSchema"),
    chats: count("chats"),
    mediaFiles: count("mediaFiles"),
    bytes: count("bytes"),
    vanished: Array.isArray(value.vanished) ? value.vanished.map(String) : [],
  };
}

function parseIndex(text: string, dir: string): IndexEntry[] {
  const entries: IndexEntry[] = [];
  const ids = new Set<string>();
  const lines = text.split("\n").filter((line) => line !== "");
  for (const [n, line] of lines.entries()) {
    const where = `${INDEX_FILE} line ${n + 1}`;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw failed(`${where} is not JSON: the backup is damaged`);
    }
    const entry = toEntry(value, dir, where);
    if (ids.has(entry.id)) {
      throw failed(
        `${where}: chat ${JSON.stringify(entry.id)} is listed twice: the backup is damaged`,
      );
    }
    ids.add(entry.id);
    entries.push(entry);
  }
  return entries;
}

const HEX_256 = /^[0-9a-f]{64}$/;

function toEntry(value: Record<string, unknown>, dir: string, where: string): IndexEntry {
  const bad = (what: string): never => {
    throw failed(`${where}: ${what}: the backup is damaged`);
  };
  const size = (x: unknown, what: string): number =>
    typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : bad(`no valid ${what}`);
  const sha = (x: unknown, what: string): string =>
    typeof x === "string" && HEX_256.test(x) ? x : bad(`no valid ${what}`);
  const inside = (x: unknown, what: string): string => {
    if (typeof x !== "string" || x === "") return bad(`no valid ${what}`);
    const resolved = path.resolve(dir, x);
    if (!resolved.startsWith(dir + path.sep))
      return bad(`${what} ${JSON.stringify(x)} leaves the backup`);
    return x;
  };

  if (typeof value.id !== "string" || value.id === "") bad("no chat id");
  if (typeof value.source !== "string") bad("no source");
  const mediaDir = value.mediaDir === null ? null : inside(value.mediaDir, "mediaDir");
  if (!Array.isArray(value.media)) bad("no media list");
  const media = (value.media as Array<Record<string, unknown>>).map((item) => {
    if (item === null || typeof item !== "object") return bad("a media entry is not an object");
    const name = item.name;
    if (typeof name !== "string" || !isSafeFileName(name)) {
      return bad(`media name ${JSON.stringify(name)} is not a file name`);
    }
    return {
      name,
      bytes: size(item.bytes, "media size"),
      sha256: sha(item.sha256, "media SHA-256"),
    };
  });
  if (media.length > 0 && mediaDir === null) bad("media files but no mediaDir");
  return {
    id: value.id as string,
    source: value.source as string,
    file: inside(value.file, "file"),
    bytes: size(value.bytes, "size"),
    sha256: sha(value.sha256, "SHA-256"),
    mediaDir,
    media,
  };
}

/** SHA-256 and size of a file, read in chunks; the first `headBytes` bytes are kept. */
async function hashFile(
  file: string,
  headBytes: number,
  signal?: AbortSignal,
): Promise<{ sha256: string; bytes: number; head: Buffer }> {
  const hash = createHash("sha256");
  const head: Buffer[] = [];
  let kept = 0;
  let bytes = 0;
  const stream = fs.createReadStream(file, {
    highWaterMark: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    if (kept < headBytes) {
      const part = chunk.subarray(0, headBytes - kept);
      head.push(part);
      kept += part.length;
    }
  }
  return { sha256: hash.digest("hex"), bytes, head: Buffer.concat(head) };
}

/**
 * `lastSyncedTimestamp` from the header line of a record, in the bytes read of its start. Null when
 * the line did not end in them (a chat held with its messages inline, bigger than the limit) or the
 * line is not a chat header.
 */
function lastSyncedOf(head: Buffer): number | null {
  const end = head.indexOf(0x0a);
  if (end < 0) return null;
  try {
    const header = JSON.parse(head.toString("utf8", 0, end)) as {
      chat?: { lastSyncedTimestamp?: unknown };
    };
    const stamp = header.chat?.lastSyncedTimestamp;
    return typeof stamp === "number" ? stamp : null;
  } catch {
    return null;
  }
}
