import Dexie from "dexie";
import type { HaevnDatabase } from "./db";

/**
 * How many live chats a provider has: the ones the archive lists, soft-deleted chats left out
 * (HVN-85). It reads the [deleted+source+title] compound index, the one the archive's provider
 * filter counts with, so a provider's stat and the archive's count for it agree. A soft-deleted
 * chat has deleted 1 and falls outside the range.
 */
export function countLiveChatsForSource(db: HaevnDatabase, source: string): Promise<number> {
  return db.chats
    .where("[deleted+source+title]")
    .between([0, source, Dexie.minKey], [0, source, Dexie.maxKey], true, true)
    .count();
}
