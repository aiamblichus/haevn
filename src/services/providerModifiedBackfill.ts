/**
 * The write of `providerLastModifiedTimestamp` for chats stored without it (HVN-165).
 *
 * An index leaves out a row that lacks its key, so a chat without the field was missing from the
 * archive under the "Modified Time" sort and from that sort's count. Every save now writes the field
 * (`saveChatToDb`); this pass writes it for the rows an older build stored: the chat's own
 * `timestamp`, as a save does. It needs no schema change. It runs once per install, at service
 * worker start; after its flag is set a start only reads the flag.
 */

import { getStorageAdapter } from "../storage";
import { log } from "../utils/logger";
import { getDB } from "./db";

/** The storage key of the flag that says the pass has finished on this install. */
export const PROVIDER_MODIFIED_BACKFILL_FLAG = "haevn.migration.providerModified";

export interface ProviderModifiedBackfillReport {
  /** `done`: the pass ran and set its flag. `already-done`: the flag was set before this call. */
  status: "done" | "already-done";
  /** Chats given the field, soft-deleted ones included (an undo brings them back). */
  updated: number;
}

let inFlight: Promise<ProviderModifiedBackfillReport> | undefined;

/**
 * Gives every chat without `providerLastModifiedTimestamp` its `timestamp`. One transaction: it
 * writes all of them or none, and only then sets the flag, so a failure is tried again at the next
 * start. Calls made while it runs share it.
 */
export function runProviderModifiedBackfill(): Promise<ProviderModifiedBackfillReport> {
  inFlight ??= backfill().finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function backfill(): Promise<ProviderModifiedBackfillReport> {
  const storage = getStorageAdapter();
  if ((await storage.get<string>(PROVIDER_MODIFIED_BACKFILL_FLAG)) === "done") {
    return { status: "already-done", updated: 0 };
  }

  const updated = await getDB()
    .chats.filter((chat) => chat.providerLastModifiedTimestamp == null)
    .modify((chat) => {
      chat.providerLastModifiedTimestamp = chat.timestamp;
    });

  await storage.set(PROVIDER_MODIFIED_BACKFILL_FLAG, "done");
  log.info(`[ProviderModifiedBackfill] done: ${updated} chat(s) given their timestamp`);
  return { status: "done", updated };
}
