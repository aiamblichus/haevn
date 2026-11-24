/**
 * The backup format, version 1 (HVN-134; architecture/backup-restore, "The contract"). What a chat's
 * backup record is, the protocol number the CLI and the extension agree on, and the name check every
 * media path goes through. No Dexie and no OPFS here: the read side now, and the write side later,
 * both import it.
 */

import type { Chat } from "../../model/haevn_model";
import type { ChatEmbeddingRecord, ChatMetadataRecord } from "../db";

/** The bridge protocol for the backup actions. The CLI refuses an extension that answers another. */
export const BACKUP_PROTOCOL = 1;

/** The `v` of line 1 of a chat record. */
export const BACKUP_RECORD_VERSION = 1;

/** The media type of a chat record: JSON lines. */
export const BACKUP_RECORD_MEDIA_TYPE = "application/x-ndjson";

/** The most chats one `backupList` answers. */
export const BACKUP_PAGE_MAX = 500;

/** Line 1 of a chat record: the chat row as stored, with its metadata and embedding rows. */
export interface BackupRecordHeader {
  v: typeof BACKUP_RECORD_VERSION;
  chat: Chat;
  metadata: ChatMetadataRecord | null;
  embedding: ChatEmbeddingRecord | null;
}

export type BackupErrorCode = "NOT_FOUND" | "BAD_REQUEST" | "PIPE_FAILED";

/** A backup request that cannot be answered. The bridge sends `code` in the error frame. */
export class BackupError extends Error {
  readonly code: BackupErrorCode;

  constructor(code: BackupErrorCode, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

/**
 * A media file name is one path segment: not empty, not "." or "..", and no slash or backslash.
 * A name that fails it is refused before the file system is touched.
 */
export function isSafeMediaName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !/[/\\]/.test(name);
}
