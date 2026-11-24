/**
 * The restore session (HVN-136, slice 4): the one piece of state a restore keeps in the extension.
 * `haevn restore` drives the loop and the extension answers one request per chat or file
 * (architecture/backup-restore, "Restore: the algorithm"); this module is what makes those
 * requests safe to answer:
 *
 *  - `beginRestore` takes the operation lock as `import`, the way `importChatBatch` does, and
 *    answers BUSY when another operation holds it. Nothing is written without it.
 *  - `restoreChat` and `restoreMedia` are refused (NO_SESSION) when no session is open, before the
 *    pipe is read or a row written.
 *  - `finishRestore` releases the lock, recalculates the provider counts the restore changed, and
 *    starts one index rebuild when the run asked for it or owes one.
 *  - An idle timer closes the session when no request has come for `RESTORE_IDLE_MS`, so a CLI that
 *    vanishes cannot hold the lock for ever. It does not run while a request is in flight (a big
 *    chat may take longer than the limit to write). A service-worker restart clears the lock and
 *    this module's state together (`clearStaleOperationLocks`).
 *
 * The session is in memory on purpose: a restore that loses it is re-run, and every chat it wrote
 * was written whole.
 */

import { restoreChatRecord, restoreMediaFile } from "../../services/backup/backupRestore";
import { BackupError } from "../../services/backup/format";
import { CacheService } from "../../services/cacheService";
import { extractProviderName } from "../../services/chatService";
import { SyncService } from "../../services/syncService";
import { fireAndForget } from "../../utils/error_utils";
import { log } from "../../utils/logger";
import { INCREMENTAL_INDEX_MAX_CHATS } from "../import/importBatch";
import { acquireOperationLock, getActiveOperation, releaseOperationLock } from "../state";

/** How long a session may wait for its next request before the extension closes it. */
export const RESTORE_IDLE_MS = 120_000;

interface RestoreSession {
  /** The chats the run announced. */
  chats: number;
  /** Whether chats are indexed as they are saved: a big run is indexed once, at the end. */
  indexPerChat: boolean;
  /** A chat asked to be indexed and was not, because the run is big. A rebuild is owed. */
  indexOwed: boolean;
  /** The first indexing failure; reported by `finishRestore`. */
  indexError?: string;
  /** The providers of the chats restored, whose counts are recalculated at the end. */
  providers: Set<string>;
  inFlight: number;
  timer: ReturnType<typeof setTimeout> | null;
}

let session: RestoreSession | null = null;
/** True while `beginRestore` waits for the lock, so two begins cannot both pass the check. */
let opening = false;

/**
 * Opens the bytes of a request: the pipe the daemon holds for it. It is called only once a session
 * is known to be open, so a refused request never touches the pipe. `bytes` is the length the daemon
 * announced, when it did.
 */
export type OpenBody = () => Promise<{ stream: ReadableStream<Uint8Array>; bytes: number | null }>;

export interface RestoreBeginResult {
  /** True when the run indexes each chat as it is saved; false when it indexes once, at the end. */
  indexPerChat: boolean;
  idleTimeoutMs: number;
}

export interface RestoreFinishResult {
  /** Set when the index could not be brought up to date. The chats are saved all the same. */
  indexError?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Opens a session: takes the lock as `import`. Throws BUSY when it is held. */
export async function beginRestore(options: { chats: number }): Promise<RestoreBeginResult> {
  if (!Number.isInteger(options.chats) || options.chats < 0) {
    throw new BackupError("BAD_REQUEST", "chats must be a whole number, zero or more");
  }
  if (session || opening) {
    throw new BackupError("BUSY", "A restore is already running. Try again when it ends.");
  }
  opening = true;
  try {
    if (!(await acquireOperationLock("import"))) {
      throw new BackupError(
        "BUSY",
        `Another operation is running (${await getActiveOperation()}). Try the restore again when it ends.`,
      );
    }
  } finally {
    opening = false;
  }

  const opened: RestoreSession = {
    chats: options.chats,
    indexPerChat: options.chats <= INCREMENTAL_INDEX_MAX_CHATS,
    indexOwed: false,
    providers: new Set(),
    inFlight: 0,
    timer: null,
  };
  session = opened;
  armIdleTimer(opened);
  return { indexPerChat: opened.indexPerChat, idleTimeoutMs: RESTORE_IDLE_MS };
}

/**
 * Replaces one chat from a record stream. `index` asks for the chat to be indexed now; the session
 * overrides it for a big run (and owes a rebuild at the end), so a client that forgets the rule
 * leaves no chat out of the index.
 */
export async function restoreChat(options: {
  chatId: string;
  openBody: OpenBody;
  index: boolean;
}): Promise<{ replaced: boolean }> {
  return withSession(async (open) => {
    const { stream, bytes } = await options.openBody();
    // The announced length is the only thing that shows a record cut exactly between two lines, so
    // a pipe that announces none is refused, not read on trust.
    if (bytes === null) {
      throw new BackupError("PIPE_FAILED", "the pipe announced no length for the record");
    }
    const { replaced, chat } = await restoreChatRecord(options.chatId, stream, bytes);

    // The chat is saved, whole. What follows is bookkeeping, and a failure in it is logged and
    // reported at the end, never allowed to fail a chat that is in.
    const provider = chat.source ? extractProviderName(chat.source) : null;
    if (provider) open.providers.add(provider);

    if (options.index) {
      if (open.indexPerChat) {
        try {
          await SyncService.addOrUpdateChatInIndex(options.chatId);
        } catch (error) {
          log.warn(`[RestoreSession] Failed to index chat ${options.chatId}:`, error);
          open.indexError ??= errorMessage(error);
        }
      } else {
        open.indexOwed = true;
      }
    }

    // Lazily, as ImportService does, to keep the handlers out of this module's imports.
    try {
      const { handleGenerateThumbnails } = await import("../handlers/galleryHandlers");
      fireAndForget(handleGenerateThumbnails(options.chatId), `Thumbnails for ${options.chatId}`);
      const { broadcastChatSynced } = await import("../utils/chatSyncUtils");
      broadcastChatSynced(chat);
    } catch (error) {
      log.warn(`[RestoreSession] Follow-up of chat ${options.chatId} failed:`, error);
    }
    return { replaced };
  });
}

/** Replaces one media file of a chat from a stream of `bytes` bytes. */
export async function restoreMedia(options: {
  chatId: string;
  name: string;
  /** The size the run announced for the file. */
  bytes: number;
  openBody: OpenBody;
}): Promise<{ bytes: number }> {
  return withSession(async () => {
    const { stream, bytes: announced } = await options.openBody();
    // A pipe that announces no length is refused like one that announces another
    if (announced !== options.bytes) {
      throw new BackupError(
        "PIPE_FAILED",
        announced === null
          ? "the pipe announced no length for the file"
          : `the pipe carries ${announced} bytes, and the request announced ${options.bytes}`,
      );
    }
    return {
      bytes: await restoreMediaFile(options.chatId, options.name, stream, options.bytes),
    };
  });
}

/** Closes the session, releases the lock, and rebuilds the index when asked or owed. */
export async function finishRestore(options: {
  rebuildIndex: boolean;
}): Promise<RestoreFinishResult> {
  const open = session;
  if (!open) {
    throw new BackupError(
      "NO_SESSION",
      "No restore is open: it was idle for too long, or the extension restarted.",
    );
  }
  return closeSession(open, options.rebuildIndex);
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function withSession<T>(work: (open: RestoreSession) => Promise<T>): Promise<T> {
  const open = session;
  if (!open) {
    throw new BackupError(
      "NO_SESSION",
      "No restore is open: start one with restoreBegin. Nothing was written.",
    );
  }
  open.inFlight += 1;
  clearIdleTimer(open);
  try {
    return await work(open);
  } finally {
    open.inFlight -= 1;
    if (session === open && open.inFlight === 0) armIdleTimer(open);
  }
}

function clearIdleTimer(open: RestoreSession): void {
  if (open.timer !== null) {
    clearTimeout(open.timer);
    open.timer = null;
  }
}

function armIdleTimer(open: RestoreSession): void {
  clearIdleTimer(open);
  open.timer = setTimeout(() => {
    open.timer = null;
    log.warn(`[RestoreSession] No request for ${RESTORE_IDLE_MS} ms: closing the restore`);
    fireAndForget(closeSession(open, false), "Close an idle restore");
  }, RESTORE_IDLE_MS);
}

async function closeSession(
  open: RestoreSession,
  rebuildIndex: boolean,
): Promise<RestoreFinishResult> {
  clearIdleTimer(open);
  if (session === open) session = null;
  const result: RestoreFinishResult = {};
  try {
    for (const provider of open.providers) {
      try {
        await CacheService.recalculateProviderStats(provider);
      } catch (error) {
        log.warn(`[RestoreSession] Failed to recalculate the ${provider} count:`, error);
      }
    }
    if (rebuildIndex || open.indexOwed) {
      try {
        await SyncService.rebuildIndex();
      } catch (error) {
        log.error("[RestoreSession] Failed to start the index rebuild:", error);
        result.indexError ??= errorMessage(error);
      }
    }
    if (open.indexError) result.indexError ??= open.indexError;
  } finally {
    await releaseOperationLock("import");
  }
  return result;
}
