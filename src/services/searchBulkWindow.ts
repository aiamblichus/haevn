// The window of a bulk operation, kept where a restart of the search worker does not lose it (HVN-88)
//
// Bulk sync and import save chats without indexing them; at `endBulk` the worker indexes the
// chats saved since the operation began, found by their save time. That time used to live in the
// worker's memory, so a worker that restarted mid-operation (the offscreen document closed, the
// worker crashed) skipped the catch-up, and a chat that was updated stayed stale in the index.
//
// The window is one row of the `cache` table in the database the worker already opens, because:
// - it survives the worker, the service worker and the browser, and a rebuild or a wipe of the
//   index files cannot take it (the index's own `meta` table lives in a file that a rebuild
//   replaces and an open may wipe);
// - it needs no change to the `SearchIndex` contract and no schema version;
// - `chrome.storage.session` is not an option: a dedicated worker has no `chrome.*` APIs, so it
//   would take a round trip through the service worker, which is the thing that also restarts.
//
// Every change is one Dexie transaction, so an `endBulk` and an `init` cannot interleave halfway.
import type { HaevnDatabase } from "./db";

export const BULK_WINDOW_KEY = "search:bulk-window";

export interface BulkWindow {
  /** Chats saved at or after this time (ms) are not in the index, as far as the worker knows. */
  since: number;
  /** `endBulk` has come: only the catch-up is still owed. A window that has not ended may be live. */
  ended: boolean;
}

function isBulkWindow(value: unknown): value is BulkWindow {
  const candidate = value as Partial<BulkWindow> | null;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof candidate.since === "number" &&
    typeof candidate.ended === "boolean"
  );
}

function sameWindow(a: BulkWindow | null, b: BulkWindow): boolean {
  return a !== null && a.since === b.since && a.ended === b.ended;
}

async function readIn(db: HaevnDatabase): Promise<BulkWindow | null> {
  const entry = await db.cache.get(BULK_WINDOW_KEY);
  return isBulkWindow(entry?.value) ? entry.value : null;
}

async function writeIn(db: HaevnDatabase, window: BulkWindow): Promise<void> {
  await db.cache.put({ id: BULK_WINDOW_KEY, value: window, lastUpdated: Date.now() });
}

/** The window on record, or null when no bulk operation owes a catch-up. */
export function readBulkWindow(db: HaevnDatabase): Promise<BulkWindow | null> {
  return readIn(db);
}

/**
 * A bulk operation begins. One that is already on record keeps the time it began with (bulk sync
 * calls this again on resume, and an `endBulk` whose catch-up has not finished still owes it), and
 * is open again; otherwise the window starts at `since`.
 */
export function openBulkWindow(db: HaevnDatabase, since: number): Promise<BulkWindow> {
  return db.transaction("rw", db.cache, async () => {
    const window: BulkWindow = { since: (await readIn(db))?.since ?? since, ended: false };
    await writeIn(db, window);
    return window;
  });
}

/** The operation ends: what is on record is now only the catch-up that is owed. Null if none. */
export function endBulkWindow(db: HaevnDatabase): Promise<BulkWindow | null> {
  return db.transaction("rw", db.cache, async () => {
    const current = await readIn(db);
    if (!current) return null;
    const window: BulkWindow = { since: current.since, ended: true };
    await writeIn(db, window);
    return window;
  });
}

/**
 * A catch-up from `window` has succeeded. An ended window is done and goes. One that has not
 * ended may be live, so it stays and starts from `caughtUpTo`. Either way only if the record is
 * still `window`: an operation that began again meanwhile has reopened it, and its chats are not
 * caught up yet.
 */
export function settleBulkWindow(
  db: HaevnDatabase,
  window: BulkWindow,
  caughtUpTo: number,
): Promise<void> {
  return db.transaction("rw", db.cache, async () => {
    if (!sameWindow(await readIn(db), window)) return;
    if (window.ended) await db.cache.delete(BULK_WINDOW_KEY);
    else await writeIn(db, { since: Math.max(window.since, caughtUpTo), ended: false });
  });
}
