/**
 * The write side of the backup service (HVN-136, slice 4): one chat record put back into the
 * archive, and one media file put back into OPFS. No Chrome API and no socket: the bytes arrive as a
 * stream the caller opened, and the lock, the pipe and the side effects (index, thumbnails, events)
 * are the bridge's and `background/backup/restoreSession.ts`'s (architecture/backup-restore, "The
 * seam").
 *
 * Restore keeps three rules, and each is kept here by what this file writes and does not write:
 *
 *  1. A chat or file whose id exists is replaced by the backup's copy: the chat's message rows, its
 *     chat row (the backup's own `lastSyncedTimestamp`, `checksum` and `syncStatus`, not "now"), its
 *     metadata and embedding rows when the backup has them, and its thumbnails (which are rebuilt
 *     from the new messages) go in one transaction. A media file is written under the same name.
 *  2. What is missing is added, by the same writes.
 *  3. Nothing else is touched. Only rows keyed by the restored chat id are written, and no file is
 *     deleted: media the replaced chat no longer names stays for the media sweep.
 */

import type { Chat, ChatMessage } from "../../model/haevn_model";
import { abortWritable, createWritableStream } from "../../utils/opfs";
import { deleteChatThumbnails, saveChatToDb } from "../chatPersistence";
import { type ChatEmbeddingRecord, type ChatMetadataRecord, getDB } from "../db";
import { MEDIA_ROOT_PATH, mediaFolderName } from "../mediaStorage";
import {
  BACKUP_RECORD_VERSION,
  BackupError,
  type BackupRecordHeader,
  isSafeMediaName,
} from "./format";

/** The fields of a restored chat that the `chatSynced` event and the provider count read. */
export type RestoredChatSummary = Pick<
  Chat,
  | "id"
  | "source"
  | "title"
  | "lastSyncedTimestamp"
  | "syncStatus"
  | "providerLastModifiedTimestamp"
  | "lastSyncAttemptMessage"
>;

export interface RestoredChat {
  /** True when the archive already had a row with this id (live or soft-deleted). */
  replaced: boolean;
  chat: RestoredChatSummary;
}

/**
 * Reads one chat record from `stream` and replaces the chat with it.
 *
 * The record is parsed line by line as it arrives, and every check (the version, the id, the key of
 * every row) runs before the first write: a record that is refused or cut short changes nothing.
 * Only then does one transaction write the chat. The rows of a very large chat are held as parsed
 * objects until then, because a transaction cannot stay open across the network; the record is
 * never one string.
 *
 * `expectedBytes` is the length the daemon announced; a stream that ends at another length is
 * refused.
 */
export async function restoreChatRecord(
  chatId: string,
  stream: ReadableStream<Uint8Array>,
  expectedBytes: number | null = null,
): Promise<RestoredChat> {
  if (chatId === "") {
    throw new BackupError("BAD_REQUEST", "a chat id is needed");
  }
  const received = { bytes: 0 };
  const record = await parseChatRecord(chatId, stream, received);
  if (expectedBytes !== null && received.bytes !== expectedBytes) {
    throw new BackupError(
      "PIPE_FAILED",
      `the record is ${received.bytes} bytes, and ${expectedBytes} were announced`,
    );
  }

  const { header, messages } = record;
  // The row as the backup stored it. Only what the archive's own flags need is set: a restored chat
  // is live, and the messages go to their table (saveChatToDb moves them and empties the row).
  const row: Chat = { ...header.chat, id: chatId, messages, deleted: 0 };
  delete row.deletedAt;

  const db = getDB();
  let replaced = false;
  await db.transaction(
    "rw",
    [db.chats, db.chatMessages, db.chatMetadata, db.chatEmbeddings, db.thumbnails, db.mediaContent],
    async () => {
      replaced = (await db.chats.where("id").equals(chatId).count()) > 0;
      await deleteChatThumbnails(chatId);
      await saveChatToDb(row);
      // A record without metadata or embedding leaves the archive's own alone
      if (header.metadata) await db.chatMetadata.put(header.metadata);
      if (header.embedding) await db.chatEmbeddings.put(header.embedding);
    },
  );

  return {
    replaced,
    chat: {
      id: chatId,
      source: row.source,
      title: row.title,
      lastSyncedTimestamp: row.lastSyncedTimestamp,
      syncStatus: row.syncStatus,
      providerLastModifiedTimestamp: row.providerLastModifiedTimestamp,
      lastSyncAttemptMessage: row.lastSyncAttemptMessage,
    },
  };
}

/**
 * Writes one media file of a chat from `stream` to `media/{folder}/{name}`, where the folder is
 * `mediaFolderName(chatId)`, as the media writer and the sweep name it. The file is replaced when
 * the writable closes, so a stream that fails or ends at the wrong length leaves the old file as it
 * was. Answers the bytes written.
 */
export async function restoreMediaFile(
  chatId: string,
  name: string,
  stream: ReadableStream<Uint8Array>,
  bytes: number,
): Promise<number> {
  if (!isSafeMediaName(name)) {
    throw new BackupError("BAD_REQUEST", `"${name}" is not a media file name`);
  }
  const folder = mediaFolderName(chatId);
  if (!isSafeMediaName(folder)) {
    throw new BackupError("BAD_REQUEST", `chat id "${chatId}" has no media folder name`);
  }
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new BackupError("BAD_REQUEST", "bytes must be the size of the file");
  }

  // The file is created before the stream is read, so a write that fails for a name the folder
  // did not have leaves an empty file under it. Nothing refers to it: the media sweep removes it,
  // and a re-run of the restore replaces it. A name that existed keeps its old bytes (the writable
  // publishes only on close).
  const writable = await createWritableStream(`${MEDIA_ROOT_PATH}/${folder}/${name}`);
  let written = 0;
  try {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      written += value.byteLength;
      if (written > bytes) {
        throw new BackupError("PIPE_FAILED", `${name} is longer than the ${bytes} bytes announced`);
      }
      // A fetch body is bytes in an ArrayBuffer; the DOM lib types the chunk more widely
      await writable.write(value as Uint8Array<ArrayBuffer>);
    }
    if (written !== bytes) {
      throw new BackupError(
        "PIPE_FAILED",
        `${name} is ${written} bytes, and ${bytes} were announced`,
      );
    }
    await writable.close();
  } catch (error) {
    await abortWritable(writable);
    throw error;
  }
  return written;
}

// ─── The record ───────────────────────────────────────────────────────────────

interface ParsedRecord {
  header: BackupRecordHeader;
  /** The message rows by id, the row's own inline messages first, so a table row wins. */
  messages: Record<string, ChatMessage>;
}

/** Reads the record's lines and checks each as it comes. Writes nothing. */
async function parseChatRecord(
  chatId: string,
  stream: ReadableStream<Uint8Array>,
  received: { bytes: number },
): Promise<ParsedRecord> {
  let header: BackupRecordHeader | null = null;
  let messages: Record<string, ChatMessage> = {};
  let lineNumber = 0;

  for await (const line of readLines(stream, received)) {
    lineNumber += 1;
    if (line === "") continue;
    const value = parseJsonLine(line, lineNumber);
    if (header === null) {
      header = checkHeader(chatId, value);
      messages = { ...(header.chat.messages ?? {}) };
    } else {
      const message = checkMessageRow(chatId, value, lineNumber);
      messages[message.id] = message;
    }
  }

  if (header === null) {
    throw new BackupError("BAD_REQUEST", "the record is empty");
  }
  return { header, messages };
}

function parseJsonLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new BackupError("BAD_REQUEST", `line ${lineNumber} of the record is not JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Line 1: the version, the chat (whose id must be the one asked for), and the two optional rows. */
function checkHeader(chatId: string, value: unknown): BackupRecordHeader {
  if (!isRecord(value)) {
    throw new BackupError("BAD_REQUEST", "line 1 of the record is not an object");
  }
  if (value.v !== BACKUP_RECORD_VERSION) {
    throw new BackupError(
      "BAD_REQUEST",
      `the record is version ${String(value.v)}, and this extension reads version ${BACKUP_RECORD_VERSION}`,
    );
  }
  const chat = value.chat;
  if (!isRecord(chat)) {
    throw new BackupError("BAD_REQUEST", "the record has no chat");
  }
  if (chat.id !== chatId) {
    throw new BackupError(
      "BAD_REQUEST",
      `the record is for chat ${String(chat.id)}, and chat ${chatId} was asked for`,
    );
  }
  if (chat.messages !== undefined && !isRecord(chat.messages)) {
    throw new BackupError("BAD_REQUEST", "the chat's messages are not an object");
  }
  return {
    v: BACKUP_RECORD_VERSION,
    chat: chat as unknown as Chat,
    metadata: checkKeyedRow<ChatMetadataRecord>(chatId, value.metadata, "metadata"),
    embedding: checkKeyedRow<ChatEmbeddingRecord>(chatId, value.embedding, "embedding"),
  };
}

/** A metadata or embedding row is the chat's own: its key is the chat id, or it is refused. */
function checkKeyedRow<T extends { chatId: string }>(
  chatId: string,
  value: unknown,
  what: string,
): T | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.chatId !== chatId) {
    throw new BackupError("BAD_REQUEST", `the record's ${what} row is not for chat ${chatId}`);
  }
  return value as unknown as T;
}

/** A message row belongs to the chat asked for: restore writes no row under another chat's key. */
function checkMessageRow(chatId: string, value: unknown, lineNumber: number): ChatMessage {
  if (!isRecord(value) || typeof value.id !== "string" || value.chatId !== chatId) {
    throw new BackupError(
      "BAD_REQUEST",
      `line ${lineNumber} of the record is not a message of chat ${chatId}`,
    );
  }
  return value as unknown as ChatMessage;
}

// ─── The stream ───────────────────────────────────────────────────────────────

/** One read; a stream that fails (a body cut short, a daemon that went away) is a failed pipe. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  try {
    return await reader.read();
  } catch (error) {
    throw new BackupError("PIPE_FAILED", `the pipe broke before the end: ${String(error)}`);
  }
}

/**
 * The lines of a UTF-8 stream, each without its newline. A record ends with a newline, so text left
 * after the last one means the stream was cut: it is refused, not parsed. One line is held whole
 * (a message row can be megabytes); the stream is not.
 */
async function* readLines(
  stream: ReadableStream<Uint8Array>,
  received: { bytes: number },
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await readChunk(reader);
      if (done) break;
      received.bytes += value.byteLength;
      const text = decodeChunk(decoder, value);
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        const line = pending + text.slice(start, end);
        pending = "";
        start = end + 1;
        yield line;
      }
      pending += text.slice(start);
    }
    pending += decodeChunk(decoder);
    if (pending !== "") {
      throw new BackupError("PIPE_FAILED", "the record ends in the middle of a line");
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeChunk(decoder: TextDecoder, chunk?: Uint8Array): string {
  try {
    return chunk ? decoder.decode(chunk, { stream: true }) : decoder.decode();
  } catch {
    throw new BackupError("BAD_REQUEST", "the record is not UTF-8 text");
  }
}
