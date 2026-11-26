/**
 * Import a batch of chats that the caller already holds in memory (the CLI's `import` over the
 * bridge). It runs the way the archive's own import runs: the operation lock is taken for the
 * whole batch, each chat is saved by `ImportService.saveImportedChat`, the saved chats are queued
 * for AI metadata when automatic generation is on, and the search index is brought up to date
 * once the chats are in.
 *
 * The archive's file import (`importOrchestrator`) streams a ZIP through a worker and is not
 * reused here; this is the same sequence for chats that need no worker.
 */

import type { Chat } from "../../model/haevn_model";
import { ImportService } from "../../services/importService";
import { queueGenerationForImportedChats } from "../../services/metadataService";
import { SyncService } from "../../services/syncService";
import type { AllProviderRawData } from "../../types/messaging";
import { log } from "../../utils/logger";
import { errorShape, fileNameShape } from "../../utils/logShape";
import { acquireOperationLock, getActiveOperation, releaseOperationLock } from "../state";

/**
 * Up to this many chats are indexed one by one as they are saved, so search keeps answering.
 * A bigger batch switches the index to bulk mode: the chats are indexed once, in one pass at the
 * end, and search keeps answering from the index as it was. One incremental add is one small
 * transaction, so the limit now only bounds how much work a save does before it returns.
 */
export const INCREMENTAL_INDEX_MAX_CHATS = 20;

/** Another long operation (bulk sync, import, bulk export) holds the operation lock. */
export class ImportBusyError extends Error {
  constructor(readonly activeOperation: string) {
    super(`Another operation is running (${activeOperation}). Try the import again when it ends.`);
    this.name = "ImportBusyError";
  }
}

export interface ImportBatchItem {
  /** What the log calls this item when it fails (a file name). */
  name: string;
  /** Parses the item. A throw counts one error and the batch goes on. */
  load: () => Promise<{ chat: Chat; raw?: AllProviderRawData }>;
}

export interface ImportBatchOptions {
  /** false skips a chat that is already in the archive */
  overwrite: boolean;
  /** false saves without indexing; the next index rebuild or init picks the chats up */
  index: boolean;
  /**
   * Runs once the chats are saved, still under the operation lock and before they are queued for
   * generation, with the ids that were saved. A throw is logged and costs only what it was to do.
   */
  afterSave?: (savedIds: string[]) => Promise<void>;
}

export interface ImportBatchResult {
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
  /**
   * Set when the index could not be brought up to date (bulk mode would not start or the
   * rebuild would not start). The chats are saved all the same; the next index init finds them.
   */
  indexError?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function importChatBatch(
  items: ImportBatchItem[],
  options: ImportBatchOptions,
): Promise<ImportBatchResult> {
  if (!(await acquireOperationLock("import"))) {
    throw new ImportBusyError(await getActiveOperation());
  }

  const result: ImportBatchResult = { processed: 0, saved: 0, skipped: 0, errors: 0 };
  const savedIds: string[] = [];
  const bulk = options.index && items.length > INCREMENTAL_INDEX_MAX_CHATS;
  let bulkStarted = false;

  try {
    if (bulk) {
      // The worker may have switched to bulk mode before the call failed, so the finish below
      // runs either way to switch it back. The chats are saved without indexing in both cases.
      bulkStarted = true;
      try {
        await SyncService.startBulkSyncIndexing();
      } catch (err) {
        log.error("[ImportBatch] Failed to start bulk indexing:", err);
        result.indexError ??= errorMessage(err);
      }
    }

    for (const item of items) {
      result.processed++;
      try {
        const { chat, raw } = await item.load();
        if (!chat.id) {
          throw new Error("Imported chat is missing id");
        }
        if (!options.overwrite && (await SyncService.getChat(chat.id))) {
          result.skipped++;
          continue;
        }
        await ImportService.saveImportedChat(chat, raw, { skipIndexing: !options.index || bulk });
        result.saved++;
        savedIds.push(chat.id);
      } catch (err) {
        result.errors++;
        log.warn("[ImportBatch] Import skipped due to parsing/transformation error", {
          file: fileNameShape(item.name),
          error: errorShape(err),
        });
      }
    }

    if (options.afterSave) {
      try {
        await options.afterSave(savedIds);
      } catch (err) {
        log.warn("[ImportBatch] The step after saving failed", { error: errorShape(err) });
      }
    }

    // The archive's import job queues each chat it saves when automatic generation is on.
    await queueGenerationForImportedChats(savedIds);
  } finally {
    try {
      if (bulkStarted) await SyncService.finishBulkSyncIndexing();
    } catch (err) {
      log.error("[ImportBatch] Failed to finish bulk indexing:", err);
      result.indexError ??= errorMessage(err);
    } finally {
      await releaseOperationLock("import");
    }
  }

  return result;
}
