/**
 * The flag that says the move of chat messages into their table has run to the end (HVN-31).
 *
 * It lives apart from the pass, so that the queue ticks can read it without importing the pass and
 * the search index it re-indexes through.
 */

import { getStorageAdapter } from "../storage";

/** The storage key of the flag; its value is `done` once a pass has found nothing left. */
export const MESSAGE_MIGRATION_FLAG = "haevn.migration.v17Messages";

/** Whether the move has run to the end. A storage read that fails throws. */
export async function isMessageMigrationDone(): Promise<boolean> {
  return (await getStorageAdapter().get<string>(MESSAGE_MIGRATION_FLAG)) === "done";
}
