/**
 * The backup directory, version 1 (architecture/backup-restore, "The backup format"):
 *
 *   <dir>/
 *     manifest.json            written last; its presence means the backup is complete
 *     index.jsonl              one line per chat, the authority for id -> files
 *     chats/<stem>.jsonl       one chat record
 *     media/<stem>/<file>      the files of the chat's OPFS media folder, byte for byte
 *
 * `<stem>` is derived from the chat id here, in the CLI. A reader takes the id and the paths from the
 * index and never decodes a name. A media file's name is the one the extension lists, as it is stored.
 */

import { createHash } from "node:crypto";

export const BACKUP_FORMAT = "haevn-backup";
export const BACKUP_VERSION = 1;

export const MANIFEST_FILE = "manifest.json";
export const INDEX_FILE = "index.jsonl";
export const PID_FILE = "backup.pid";
export const CHATS_DIR = "chats";
export const MEDIA_DIR = "media";

/** Longest stem before it is cut and given a hash: file names top out at 255 bytes on APFS and ext4. */
const MAX_STEM = 180;

/** One media file in the index: the extension's name for it, its size and its SHA-256. */
export interface IndexMedia {
  name: string;
  bytes: number;
  sha256: string;
}

/**
 * One line of `index.jsonl`. `file` and `mediaDir` are paths from the backup's root (`chats/x.jsonl`,
 * `media/x`); `mediaDir` is null for a chat with no media. The files of the media folder are
 * `<mediaDir>/<name>`.
 */
export interface IndexEntry {
  id: string;
  source: string;
  file: string;
  bytes: number;
  sha256: string;
  mediaDir: string | null;
  media: IndexMedia[];
}

export interface Manifest {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  haevnVersion: string;
  dbSchema: number;
  chats: number;
  mediaFiles: number;
  /** Chat records and media files together. */
  bytes: number;
  /** Chats the listing named that were gone, or soft-deleted, by the time they were read. */
  vanished: string[];
}

/**
 * The name two paths must differ by to be different on a case-insensitive, normalization-insensitive
 * file system (APFS by default): composed form, lower case.
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * The stem of the files of one chat: `encodeURIComponent` of the id, so it is ASCII and has no
 * separator. A stem of dots only would be `.` or `..` as a directory, so its dots are written out; a
 * stem too long for a file name is cut and given a hash of the id.
 */
export function stemOf(chatId: string): string {
  if (chatId === "") throw new Error("a chat id is empty");
  let stem: string;
  try {
    stem = encodeURIComponent(chatId);
  } catch {
    throw new Error(`chat id ${JSON.stringify(chatId)} is not valid text`);
  }
  if (/^\.+$/.test(stem)) stem = stem.replaceAll(".", "%2E");
  if (stem.length > MAX_STEM) {
    const hash = createHash("sha256").update(chatId).digest("hex").slice(0, 16);
    stem = `${stem.slice(0, MAX_STEM - 17)}~${hash}`;
  }
  return stem;
}

/**
 * Hands out the stems of a run, so that no two chats share a name on a case-insensitive disk: the
 * second of two ids that differ only by case gets `~2` after its stem (then `~3`, …), until the name
 * is free. The order of the listing decides who keeps the plain stem.
 */
export class StemAllocator {
  private readonly taken = new Set<string>();

  assign(chatId: string): string {
    const base = stemOf(chatId);
    let stem = base;
    for (let n = 2; this.taken.has(foldName(stem)); n++) stem = `${base}~${n}`;
    this.taken.add(foldName(stem));
    return stem;
  }
}

/** A media file name from the listing is one path segment that is not `.` or `..`. */
export function isSafeFileName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\\0]/.test(name);
}
