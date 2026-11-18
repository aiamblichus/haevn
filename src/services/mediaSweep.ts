/**
 * Media sweep: removes the files in OPFS `media/` that nothing refers to any more (HVN-90).
 *
 * A chat's media lives at `media/{chatId}/{messageId}_{n}.{ext}`. Files are left behind when a
 * chat is synced again and its messages change, when a media delete fails, and when media is
 * downloaded for a save that never happens. The sweep deletes:
 *
 *  - files in a chat's folder that no message of that chat refers to, and
 *  - the files of a folder whose chat does not exist (a soft-deleted chat still exists until the
 *    Janitor hard-deletes it).
 *
 * What keeps a file safe:
 *
 *  - A file younger than a day is never deleted. Media is downloaded before the chat is saved, so
 *    a young file may be waiting for a save that has not happened yet.
 *  - What a chat refers to is read from the whole stored record of each message and from the chat
 *    row: every string that is a path (it starts with `media/`, or `/media/`) is a reference,
 *    wherever it sits. Text that merely mentions a path is not searched.
 *  - A chat is skipped whole, and its folder left as it is, when: its messages cannot be loaded or
 *    read; it has files but no messages; it was saved within the last day (a backstop for a file
 *    whose modification time did not move); or any of its media is held only as a link
 *    (`image-url`, `document-url`, ...), which is what a failed download leaves, and then the
 *    old local file may be the only copy.
 *  - Only `media/` is walked. The search index (`.haevn-search/`), exports and import staging sit
 *    beside it and are never listed.
 *
 * The sweep runs in the service worker: every step is a short OPFS or IndexedDB call, one chat's
 * messages are in memory at a time, and it yields between folders and every few files.
 */

import type { ChatMessage } from "../model/haevn_model";
import { log } from "../utils/logger";
import {
  deleteFileFromOpfs,
  getFileMetadata,
  listDirectories,
  listFiles,
  removeDirectory,
} from "../utils/opfs";
import { getDB } from "./db";
import { MEDIA_ROOT_PATH, mediaFolderName } from "./mediaStorage";

/** A file must be at least this old (by its modification time) before the sweep may delete it. */
export const MEDIA_SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** How long after a finished sweep the Janitor sweeps again. */
export const MEDIA_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Files between two yields to the event loop. */
const YIELD_EVERY_FILES = 50;

/** Skipped chats the report names (the count is always complete). */
const REPORT_SKIPPED_LIMIT = 50;

export interface MediaSweepOptions {
  /** Count what would go and delete nothing. */
  dryRun?: boolean;
  /** The clock, for tests. */
  now?: number;
  /** Overrides {@link MEDIA_SWEEP_MIN_AGE_MS}, for tests. */
  minAgeMs?: number;
}

export interface SkippedChat {
  /** The chat, or the media folder name when the chat does not exist. */
  chatId: string;
  reason: string;
  /** The files in its folder, and their bytes, all of which stayed. */
  files: number;
  bytes: number;
}

export interface MediaSweepReport {
  dryRun: boolean;
  /** False when another sweep was running and this one did nothing. */
  ran: boolean;
  /** Media folders found, and files in them (before any deletion). */
  folders: number;
  filesScanned: number;
  /** Files deleted, or in a dry run the files that would be, and their bytes. */
  files: number;
  bytes: number;
  /** Chats (folders with a chat) that lost at least one file, and folders with no chat at all. */
  chats: number;
  orphanFolders: number;
  /** Unreferenced files kept because they are younger than the minimum age. */
  tooYoung: number;
  /** Deletes that failed; the files stay for the next run. */
  failedDeletes: number;
  /** Gallery rows (thumbnail and content) that pointed at a file that went. */
  thumbnailRows: number;
  contentRows: number;
  /** Chats left alone whole, and every file in their folders (referenced or not) and its bytes. */
  skippedChats: number;
  skippedFiles: number;
  skippedBytes: number;
  /** Of the skipped chats, those held back because some media is only a link; counted in the above too. */
  skippedForRemoteMedia: { chats: number; files: number };
  /** The first skipped chats, with the reason. */
  skipped: SkippedChat[];
  durationMs: number;
}

function emptyReport(dryRun: boolean): MediaSweepReport {
  return {
    dryRun,
    ran: true,
    folders: 0,
    filesScanned: 0,
    files: 0,
    bytes: 0,
    chats: 0,
    orphanFolders: 0,
    tooYoung: 0,
    failedDeletes: 0,
    thumbnailRows: 0,
    contentRows: 0,
    skippedChats: 0,
    skippedFiles: 0,
    skippedBytes: 0,
    skippedForRemoteMedia: { chats: 0, files: 0 },
    skipped: [],
    durationMs: 0,
  };
}

/** A chat whose messages cannot be read with certainty; its folder is left alone. */
class UnreadableChat extends Error {}

const MAX_DEPTH = 64;

/** What a walk over stored records found: the media paths they name, and whether any media is only a link. */
export interface MediaScan {
  refs: Set<string>;
  remote: boolean;
}

/** The kinds of content that hold media by its address: `image-url`, `video-url`, `audio-url`, `document-url`. */
const REMOTE_KIND = /-url$/;

/**
 * Walks a stored record, whatever its shape, and adds to `scan.refs` every string that is a media
 * path: it starts with `media/` (or `/media/`, which is read as `media/`). It looks at every value
 * of every object and array, so a path counts wherever a writer puts it. Content of kind `binary`
 * must carry its path as a string, or the record cannot be read (it throws). Content that is only a
 * link sets `scan.remote`.
 */
export function scanForMedia(value: unknown, scan: MediaScan, depth = 0): void {
  if (depth > MAX_DEPTH) throw new UnreadableChat("a record nested too deeply");
  if (typeof value === "string") {
    if (value.startsWith("media/")) scan.refs.add(value);
    else if (value.startsWith("/media/")) scan.refs.add(value.slice(1));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanForMedia(item, scan, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "binary" && typeof record.data !== "string") {
    throw new UnreadableChat("binary content without a path");
  }
  if (typeof record.kind === "string" && REMOTE_KIND.test(record.kind)) scan.remote = true;
  for (const child of Object.values(record)) scanForMedia(child, scan, depth + 1);
}

function scanMessage(message: ChatMessage, scan: MediaScan): void {
  if (!message || !Array.isArray(message.message)) {
    throw new UnreadableChat("a message without a body");
  }
  scanForMedia(message, scan);
}

interface LoadedChats {
  scan: MediaScan;
  /** Messages found, in the table and embedded in the rows. */
  messages: number;
  sources: string[];
  /** The latest time any of the chats was saved, if one says. */
  lastSyncedAt: number | undefined;
}

/** What the messages and rows of these chats say. Throws {@link UnreadableChat} or a load error. */
async function loadChats(chatIds: string[]): Promise<LoadedChats> {
  const db = getDB();
  const scan: MediaScan = { refs: new Set(), remote: false };
  const sources: string[] = [];
  let messages = 0;
  let lastSyncedAt: number | undefined;
  for (const chatId of chatIds) {
    const stored = await db.chatMessages.where("chatId").equals(chatId).toArray();
    for (const message of stored) scanMessage(message, scan);
    messages += stored.length;
    const row = await db.chats.get(chatId);
    if (!row) throw new UnreadableChat("the chat is gone");
    // A chat saved before messages had a table of their own carries them in its row
    const embedded = Object.values(row.messages ?? {});
    for (const message of embedded) {
      if (!message || !Array.isArray(message.message)) {
        throw new UnreadableChat("a message without a body");
      }
    }
    messages += embedded.length;
    // The whole row: its messages, and any other field a writer put a path in
    scanForMedia(row, scan);
    sources.push(row.source);
    if (typeof row.lastSyncedTimestamp === "number") {
      lastSyncedAt = Math.max(lastSyncedAt ?? row.lastSyncedTimestamp, row.lastSyncedTimestamp);
    }
  }
  return { scan, messages, sources, lastSyncedAt };
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let running = false;

/** Runs `work` unless a sweep is already running (here, or in another context of the extension). */
async function exclusively<T>(work: () => Promise<T>): Promise<T | null> {
  if (running) return null;
  running = true;
  try {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) return await work();
    return await locks.request("haevn-media-sweep", { ifAvailable: true }, async (lock) =>
      lock ? await work() : null,
    );
  } finally {
    running = false;
  }
}

/**
 * Sweeps unreferenced media out of OPFS. See the file's header for what is deleted and what is
 * never touched. With `dryRun` nothing is deleted or written, and the report says what would be.
 */
export async function sweepMedia(options: MediaSweepOptions = {}): Promise<MediaSweepReport> {
  const dryRun = options.dryRun ?? false;
  const report = await exclusively(() => runSweep(options, dryRun));
  if (report) return report;
  const idle = emptyReport(dryRun);
  idle.ran = false;
  log.info("[MediaSweep] Another sweep is running; nothing to do");
  return idle;
}

async function runSweep(options: MediaSweepOptions, dryRun: boolean): Promise<MediaSweepReport> {
  const started = Date.now();
  const now = options.now ?? started;
  const minAgeMs = options.minAgeMs ?? MEDIA_SWEEP_MIN_AGE_MS;
  const db = getDB();
  const report = emptyReport(dryRun);

  // The chats that exist (soft-deleted ones too), by the folder their media goes in
  const chatsByFolder = new Map<string, string[]>();
  for (const chatId of (await db.chats.toCollection().primaryKeys()) as string[]) {
    const folder = mediaFolderName(chatId);
    const ids = chatsByFolder.get(folder);
    if (ids) ids.push(chatId);
    else chatsByFolder.set(folder, [chatId]);
  }

  /** Leaves a chat's folder as it is, and counts the files in it. */
  const skipChat = async (
    chatId: string,
    dir: string,
    names: string[],
    reason: string,
    remoteMedia = false,
  ) => {
    let bytes = 0;
    for (const name of names) bytes += (await getFileMetadata(`${dir}/${name}`))?.size ?? 0;
    report.skippedChats += 1;
    report.skippedFiles += names.length;
    report.skippedBytes += bytes;
    if (remoteMedia) {
      report.skippedForRemoteMedia.chats += 1;
      report.skippedForRemoteMedia.files += names.length;
    }
    if (report.skipped.length < REPORT_SKIPPED_LIMIT) {
      report.skipped.push({ chatId, reason, files: names.length, bytes });
    }
    log.warn(`[MediaSweep] Skipping ${chatId}: ${reason} (${names.length} files stay)`);
  };

  const folders = await listDirectories(MEDIA_ROOT_PATH);
  report.folders = folders.length;
  let sinceYield = 0;

  for (const folder of folders) {
    const dir = `${MEDIA_ROOT_PATH}/${folder}`;
    const chatIds = chatsByFolder.get(folder) ?? [];
    const names = await listFiles(dir);
    report.filesScanned += names.length;

    // What the folder's chats refer to; a folder with no chat refers to nothing
    let refs = new Set<string>();
    let sources: string[] = [];
    if (chatIds.length > 0) {
      const label = chatIds.join(",");
      let loaded: LoadedChats;
      try {
        loaded = await loadChats(chatIds);
      } catch (error) {
        if (error instanceof UnreadableChat) {
          await skipChat(label, dir, names, `its messages cannot be read (${error.message})`);
        } else {
          log.warn("[MediaSweep] Load failed", error);
          await skipChat(label, dir, names, "its messages did not load");
        }
        continue;
      }
      if (loaded.messages === 0 && names.length > 0) {
        await skipChat(label, dir, names, "files, but no messages to say what they are for");
        continue;
      }
      if (loaded.lastSyncedAt !== undefined && now - loaded.lastSyncedAt < minAgeMs) {
        await skipChat(label, dir, names, "saved within the last day");
        continue;
      }
      if (loaded.scan.remote) {
        await skipChat(
          label,
          dir,
          names,
          "some of its media is only a link, so its files may be the only copy",
          true,
        );
        continue;
      }
      refs = loaded.scan.refs;
      sources = loaded.sources;
    }

    const gone = new Set<string>();
    let goneBytes = 0;
    for (const name of names) {
      const path = `${dir}/${name}`;
      if (refs.has(path)) continue;

      const meta = await getFileMetadata(path);
      if (!meta) continue;
      // A time that is missing, zero or in the future cannot say the file is old: only a time
      // that is a whole minimum age behind now does
      if (!(meta.lastModified > 0 && now - meta.lastModified >= minAgeMs)) {
        report.tooYoung += 1;
        continue;
      }

      if (!dryRun) {
        try {
          await deleteFileFromOpfs(path);
        } catch (error) {
          report.failedDeletes += 1;
          log.warn(`[MediaSweep] Could not delete ${path}`, error);
          continue;
        }
      }
      gone.add(path);
      goneBytes += meta.size;

      if (++sinceYield >= YIELD_EVERY_FILES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }

    if (gone.size > 0) {
      report.files += gone.size;
      report.bytes += goneBytes;
      if (chatIds.length > 0) report.chats += 1;
      if (!dryRun) {
        // The chat and what went, never the names of the files
        log.info(
          `[MediaSweep] ${chatIds.length > 0 ? `Chat ${chatIds.join(",")} (${sources.join(",")})` : `Folder ${folder} (no chat)`}: ` +
            `removed ${gone.size} files, ${goneBytes} bytes`,
        );
      }
      await forgetGalleryRows([...chatIds, folder], gone, dryRun, report);
    }

    if (chatIds.length === 0) {
      report.orphanFolders += 1;
      if (!dryRun) await removeEmptyFolder(dir);
    }

    await yieldToEventLoop();
  }

  report.durationMs = Date.now() - started;
  log.info(
    `[MediaSweep] ${dryRun ? "Dry run" : "Swept"}: ${report.files} files, ${report.bytes} bytes, ` +
      `${report.chats} chats, ${report.orphanFolders} folders without a chat, ` +
      `${report.tooYoung} unreferenced files too young to go, ${report.failedDeletes} failed deletes, ` +
      `${report.skippedChats} chats skipped (${report.skippedFiles} files, ${report.skippedBytes} bytes, ` +
      `${report.skippedForRemoteMedia.chats} for media held only as a link), ` +
      `${report.thumbnailRows} thumbnails and ` +
      `${report.contentRows} content rows ${dryRun ? "to remove" : "removed"} ` +
      `in ${report.durationMs} ms`,
    report,
  );
  return report;
}

/** Removes the folder if the sweep left it empty; a folder that still holds anything stays. */
async function removeEmptyFolder(dir: string): Promise<void> {
  if ((await listFiles(dir)).length > 0) return;
  try {
    await removeDirectory(dir, { recursive: false });
  } catch (error) {
    // Not empty (a subfolder, a file written meanwhile) or locked: the next run looks again
    log.debug(`[MediaSweep] Left folder ${dir}`, error);
  }
}

/**
 * The gallery keeps a thumbnail row and a content row (which holds the file's path) per image.
 * Rows that point at a file the sweep deleted would show a broken image, so they go too.
 */
async function forgetGalleryRows(
  chatIds: string[],
  deletedPaths: Set<string>,
  dryRun: boolean,
  report: MediaSweepReport,
): Promise<void> {
  const db = getDB();
  for (const chatId of new Set(chatIds)) {
    const thumbs = await db.thumbnails.where("chatId").equals(chatId).toArray();
    const ids = thumbs.map((t) => t.id).filter((id): id is number => id !== undefined);
    if (ids.length === 0) continue;
    const contents = await db.mediaContent.bulkGet(ids);
    const stale = ids.filter((_, i) => {
      const content = contents[i]?.content;
      return typeof content === "string" && deletedPaths.has(content);
    });
    if (stale.length === 0) continue;
    report.thumbnailRows += stale.length;
    report.contentRows += stale.length;
    if (dryRun) continue;
    await db.transaction("rw", db.thumbnails, db.mediaContent, async () => {
      await db.mediaContent.bulkDelete(stale);
      await db.thumbnails.bulkDelete(stale);
    });
  }
}
