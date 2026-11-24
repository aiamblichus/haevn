/**
 * The read side of the backup service (HVN-134, slice 2): the live chats a backup lists, one chat's
 * record as JSON lines, and one media file. No Chrome API and no socket. The bridge calls these, and
 * the CLI's engine reaches them through the bridge (architecture/backup-restore, "The seam").
 *
 * A chat is live when its `deleted` flag is 0, the test the archive's counts use (liveChatCount).
 * A soft-deleted chat is in no backup.
 */

import type { Chat } from "../../model/haevn_model";
import { getOPFSRoot } from "../../utils/opfs";
import { getDB } from "../db";
import { MEDIA_ROOT_PATH, mediaFolderName } from "../mediaStorage";
import {
  BACKUP_PROTOCOL,
  BACKUP_RECORD_MEDIA_TYPE,
  BACKUP_RECORD_VERSION,
  BackupError,
  type BackupRecordHeader,
  isSafeMediaName,
} from "./format";

export interface BackupMediaFile {
  name: string;
  bytes: number;
}

export interface BackupChatListing {
  id: string;
  source: string;
  media: BackupMediaFile[];
}

export interface BackupChatPage {
  chats: BackupChatListing[];
  /** The key to pass as `after` for the next page; absent on the last page. */
  next?: string;
}

export interface BackupSummary {
  protocol: number;
  /** The Dexie schema version the archive is at: a restore needs an extension at least this new. */
  dbSchema: number;
  liveChats: number;
}

/**
 * The live chats after the key `after` (exclusive), in primary-key order, with each chat's media
 * folder. A key cursor: a chat synced between two pages cannot shift the rows the second page sees.
 */
export async function listBackupChats(options: {
  after?: string;
  limit: number;
}): Promise<BackupChatPage> {
  const db = getDB();
  const from =
    options.after === undefined
      ? db.chats.toCollection()
      : db.chats.where(":id").above(options.after);
  // One row more than a page, so the page knows whether another follows. The live filter runs
  // before the limit, so soft-deleted rows neither fill a page nor appear on it.
  const rows = await from
    .filter((chat) => chat.deleted === 0)
    .limit(options.limit + 1)
    .toArray();

  const hasMore = rows.length > options.limit;
  const page = hasMore ? rows.slice(0, options.limit) : rows;
  const chats: BackupChatListing[] = [];
  for (const chat of page) {
    const id = chatKey(chat);
    chats.push({ id, source: chat.source, media: await listMediaFiles(id) });
  }
  return hasMore ? { chats, next: chats[chats.length - 1].id } : { chats };
}

/**
 * One chat as a record: line 1 is the header (the chat row as stored, its metadata and embedding
 * rows, or null), then one line per chatMessages row in key order. A chat still held for the move
 * (HVN-31) has its messages in its row; that row is written as stored, so they stay inline.
 *
 * The lines are parts of one Blob, so a large chat is never one string in the page.
 */
export async function chatRecordBlob(chatId: string): Promise<Blob> {
  const db = getDB();
  const lines: string[] = [];
  // One read transaction over the four tables, so the record is one moment of the chat.
  await db.transaction(
    "r",
    db.chats,
    db.chatMessages,
    db.chatMetadata,
    db.chatEmbeddings,
    async () => {
      const chat = await db.chats.get(chatId);
      if (!chat || chat.deleted !== 0) {
        throw new BackupError("NOT_FOUND", `chat ${chatId} is not in the archive`);
      }
      const header: BackupRecordHeader = {
        v: BACKUP_RECORD_VERSION,
        chat,
        metadata: (await db.chatMetadata.get(chatId)) ?? null,
        embedding: (await db.chatEmbeddings.get(chatId)) ?? null,
      };
      lines.push(jsonLine(header));
      await db.chatMessages
        .where("chatId")
        .equals(chatId)
        .each((message) => {
          lines.push(jsonLine(message));
        });
    },
  );
  return new Blob(lines, { type: BACKUP_RECORD_MEDIA_TYPE });
}

/** One media file of a chat, as the OPFS file it is stored in. */
export async function mediaFile(chatId: string, name: string): Promise<File> {
  if (!isSafeMediaName(name)) {
    throw new BackupError("BAD_REQUEST", `"${name}" is not a media file name`);
  }
  const dir = await chatMediaDirectory(chatId);
  const handle = dir ? await existingFileHandle(dir, name) : null;
  if (!handle) {
    throw new BackupError("NOT_FOUND", `chat ${chatId} has no media file ${name}`);
  }
  return handle.getFile();
}

/** The counts and versions a backup run starts from. The bridge adds the extension's version. */
export async function backupSummary(): Promise<BackupSummary> {
  const db = getDB();
  return {
    protocol: BACKUP_PROTOCOL,
    dbSchema: db.verno,
    liveChats: await db.chats.where("deleted").equals(0).count(),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A stored chat row always has its id: saveChatToDb refuses a chat without one. */
function chatKey(chat: Chat): string {
  return chat.id as string;
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

/**
 * The OPFS folder of a chat's media: `media/{folder}`, with the folder name the media writer uses
 * (mediaFolderName), so a chat id with a colon finds the files it was written to. Null when the
 * chat has no folder.
 */
async function chatMediaDirectory(chatId: string): Promise<FileSystemDirectoryHandle | null> {
  const folder = mediaFolderName(chatId);
  if (folder === "") {
    throw new BackupError("BAD_REQUEST", "a chat id is needed");
  }
  try {
    const root = await getOPFSRoot();
    const media = await root.getDirectoryHandle(MEDIA_ROOT_PATH);
    return await media.getDirectoryHandle(folder);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Every file in a chat's folder with its size, sorted by name. A folder that is not there is an
 * empty list; any other OPFS failure is thrown, so a backup never looks complete while it is not.
 */
async function listMediaFiles(chatId: string): Promise<BackupMediaFile[]> {
  const dir = await chatMediaDirectory(chatId);
  if (!dir) return [];
  const files: BackupMediaFile[] = [];
  // `entries()` is an async iterator at runtime; the DOM lib in this project does not type it
  // (as src/utils/opfs.ts does).
  // @ts-expect-error - AsyncIterator types
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== "file") continue;
    const file = await (handle as FileSystemFileHandle).getFile();
    files.push({ name, bytes: file.size });
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

async function existingFileHandle(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(name);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as DOMException | undefined)?.name === "NotFoundError";
}
