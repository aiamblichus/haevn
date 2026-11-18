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
 *  - What a chat refers to is read from the structure of its messages: every `binary` content
 *    object, wherever it sits, names its file in `data`. Text is never searched for paths.
 *  - A chat whose messages cannot be loaded, whose structure cannot be read, or which has files
 *    but no messages at all is skipped whole: its folder is left as it is.
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
  skippedChats: number;
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
    skipped: [],
    durationMs: 0,
  };
}

/** A chat whose messages cannot be read with certainty; its folder is left alone. */
class UnreadableChat extends Error {}

const MAX_DEPTH = 64;

/**
 * Adds to `refs` the storage path of every `binary` content object inside `value`.
 * The paths of other media are the same objects wherever they sit (a user prompt, a response part,
 * a tool result), so the walk looks at the shape, not at the position.
 */
export function collectMediaRefs(value: unknown, refs: Set<string>, depth = 0): void {
  if (depth > MAX_DEPTH) throw new UnreadableChat("message nested too deeply");
  if (Array.isArray(value)) {
    for (const item of value) collectMediaRefs(item, refs, depth + 1);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (record.kind === "binary") {
    if (typeof record.data !== "string") throw new UnreadableChat("binary content without a path");
    refs.add(record.data);
  }
  for (const child of Object.values(record)) {
    if (child !== null && typeof child === "object") collectMediaRefs(child, refs, depth + 1);
  }
}

function collectMessageRefs(message: ChatMessage, refs: Set<string>): void {
  if (!message || !Array.isArray(message.message)) {
    throw new UnreadableChat("a message without a body");
  }
  collectMediaRefs(message.message, refs);
}

/** Every media path the messages of these chats refer to. Throws {@link UnreadableChat} or a load error. */
async function loadReferences(chatIds: string[]): Promise<{ refs: Set<string>; messages: number }> {
  const db = getDB();
  const refs = new Set<string>();
  let messages = 0;
  for (const chatId of chatIds) {
    const stored = await db.chatMessages.where("chatId").equals(chatId).toArray();
    for (const message of stored) collectMessageRefs(message, refs);
    messages += stored.length;
    // A chat saved before messages had a table of their own carries them in its row
    const row = await db.chats.get(chatId);
    if (!row) throw new UnreadableChat("the chat is gone");
    const embedded = Object.values(row.messages ?? {});
    for (const message of embedded) collectMessageRefs(message, refs);
    messages += embedded.length;
  }
  return { refs, messages };
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

  const skip = (chatId: string, reason: string) => {
    report.skippedChats += 1;
    if (report.skipped.length < REPORT_SKIPPED_LIMIT) report.skipped.push({ chatId, reason });
    log.warn(`[MediaSweep] Skipping ${chatId}: ${reason}`);
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
    if (chatIds.length > 0) {
      try {
        const loaded = await loadReferences(chatIds);
        if (loaded.messages === 0 && names.length > 0) {
          skip(chatIds.join(","), "files, but no messages to say what they are for");
          continue;
        }
        refs = loaded.refs;
      } catch (error) {
        const reason =
          error instanceof UnreadableChat
            ? `its messages cannot be read (${error.message})`
            : "its messages did not load";
        skip(chatIds.join(","), reason);
        if (!(error instanceof UnreadableChat)) log.warn("[MediaSweep] Load failed", error);
        continue;
      }
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
      `${report.skippedChats} chats skipped, ${report.thumbnailRows} thumbnails and ` +
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
