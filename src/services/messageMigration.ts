/**
 * The move of chat messages from the chat row into the chatMessages table (HVN-31).
 *
 * Before DB v17 a chat kept its messages inside its row. v17 gave them a table of their own, and a
 * chat saved since has none inline. A user who updates from an older version still has rows of the
 * old layout, and this pass moves them. It runs once per install, at service worker start, and
 * after its flag is set a start only reads the flag.
 *
 * The pass walks the chats by primary key in batches. A chat with messages in its row is moved in
 * one transaction over `chats` and `chatMessages`, then indexed again. A chat that fails is logged
 * and left as it was, and the flag stays unset so that the next start tries it again. A pass that
 * moved something runs once more, and only a pass that finds nothing left sets the flag. A pass cut
 * short by a stop is finished by the next start, since every chat is moved or skipped on its own.
 */

import type { Chat } from "../model/haevn_model";
import { getStorageAdapter } from "../storage";
import { log } from "../utils/logger";
import { getDB } from "./db";
import { SyncService } from "./syncService";

/** The storage key of the flag; its value is `done` once a pass has found nothing left. */
export const MESSAGE_MIGRATION_FLAG = "haevn.migration.v17Messages";

const DEFAULT_BATCH_SIZE = 20;

export interface MessageMigrationOptions {
  /** Chats read per batch. Each chat is moved in a transaction of its own; batches yield between. */
  batchSize?: number;
  /** Run the passes even when the flag says they are done. The debug command does. */
  force?: boolean;
  /** Ends the pass before its next batch, as a service worker shutdown would. The flag stays unset. */
  signal?: AbortSignal;
  /** Called when a batch is done. */
  onBatch?: (batch: number) => void;
}

export interface MessageMigrationReport {
  /** `done`: the flag is set. `already-done`: it was set before this call. `incomplete`: a chat failed, so the next start tries again. `stopped`: a pass was cut short. */
  status: "done" | "already-done" | "incomplete" | "stopped";
  /** Passes made over the chats. */
  passes: number;
  /** Chats read, over all passes. */
  scanned: number;
  /** Chats moved. */
  migrated: number;
  /** Messages moved. */
  messages: number;
  /** Chats that were not moved; they keep their messages in their row until the next start. */
  failed: string[];
  /** Moved chats that the search index did not take; a rebuild indexes them. */
  unindexed: string[];
}

let inFlight: Promise<MessageMigrationReport> | undefined;

/**
 * Moves the messages of the chats in the old layout into their table. Calls made while a pass is
 * running share it. A failing chat is logged and reported, and does not reject the call.
 */
export function runMessageMigration(
  options: MessageMigrationOptions = {},
): Promise<MessageMigrationReport> {
  inFlight ??= migrate(options).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function migrate(options: MessageMigrationOptions): Promise<MessageMigrationReport> {
  const report: MessageMigrationReport = {
    status: "done",
    passes: 0,
    scanned: 0,
    migrated: 0,
    messages: 0,
    failed: [],
    unindexed: [],
  };

  if (
    !options.force &&
    (await getStorageAdapter().get<string>(MESSAGE_MIGRATION_FLAG)) === "done"
  ) {
    report.status = "already-done";
    log.info("[MessageMigration] already done; nothing to do");
    return report;
  }

  for (;;) {
    report.passes++;
    const pass = await runPass(options, report);
    if (pass.stopped) {
      report.status = "stopped";
      break;
    }
    if (pass.failed > 0) {
      report.status = "incomplete";
      break;
    }
    if (pass.moved === 0) {
      await getStorageAdapter().set(MESSAGE_MIGRATION_FLAG, "done");
      report.status = "done";
      break;
    }
  }

  log.info(
    `[MessageMigration] ${report.status}: ${report.scanned} chats read in ${report.passes} pass(es), ` +
      `${report.migrated} moved (${report.messages} messages), ${report.failed.length} failed, ` +
      `${report.unindexed.length} not indexed`,
  );
  return report;
}

interface PassCount {
  moved: number;
  failed: number;
  stopped: boolean;
}

async function runPass(
  options: MessageMigrationOptions,
  report: MessageMigrationReport,
): Promise<PassCount> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const pass: PassCount = { moved: 0, failed: 0, stopped: false };
  let after: string | undefined;

  for (let batch = 1; ; batch++) {
    if (options.signal?.aborted) return { ...pass, stopped: true };

    const rows = await readBatch(after, batchSize);
    if (rows.length === 0) return pass;
    after = rows[rows.length - 1].id;
    report.scanned += rows.length;

    for (const row of rows) {
      // A chat with no messages in its row is the common case, and costs nothing more than this
      if (Object.keys(row.messages ?? {}).length === 0) continue;

      const chatId = row.id as string;
      try {
        const moved = await moveChat(chatId);
        if (!moved) continue;
        pass.moved++;
        report.migrated++;
        report.messages += moved.messages;
        // A soft-deleted chat is out of the index, and stays out until the janitor removes it
        if (!moved.deleted) await reindex(chatId, report);
      } catch (error) {
        pass.failed++;
        report.failed.push(chatId);
        log.error(
          `[MessageMigration] Chat ${chatId} was not moved; it keeps its messages in its row until the next start`,
          error,
        );
      }
    }

    options.onBatch?.(batch);
    await yieldToEventLoop();
  }
}

/** The chats after `after` (by primary key), `size` of them. */
function readBatch(after: string | undefined, size: number): Promise<Chat[]> {
  const chats = getDB().chats;
  const query = after === undefined ? chats.toCollection() : chats.where(":id").above(after);
  return query.limit(size).toArray();
}

/**
 * Moves one chat's messages from its row into the table, in one transaction. The row is read
 * inside it, so a save that moved the chat since the batch was read is not overwritten. Returns
 * what was moved, or undefined when there was nothing left to move.
 */
async function moveChat(
  chatId: string,
): Promise<{ messages: number; deleted: boolean } | undefined> {
  const db = getDB();
  return db.transaction("rw", db.chats, db.chatMessages, async () => {
    const row = await db.chats.get(chatId);
    const inline = Object.values(row?.messages ?? {});
    if (!row || inline.length === 0) return undefined;

    await db.chatMessages.where("chatId").equals(chatId).delete();
    await db.chatMessages.bulkPut(inline.map((message) => ({ ...message, chatId })));
    await db.chats.update(chatId, { messages: {} });
    return { messages: inline.length, deleted: row.deleted === 1 };
  });
}

async function reindex(chatId: string, report: MessageMigrationReport): Promise<void> {
  try {
    await SyncService.addOrUpdateChatInIndex(chatId);
  } catch (error) {
    report.unindexed.push(chatId);
    log.warn(`[MessageMigration] Chat ${chatId} moved but not indexed`, error);
  }
}

const yieldToEventLoop = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
