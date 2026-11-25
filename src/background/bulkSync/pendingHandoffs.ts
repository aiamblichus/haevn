/**
 * The chats a bulk sync has handed to the worker and the worker has not yet reported on (HVN-123).
 *
 * The extraction tab does the worker's media downloads (`fetchBlob`), so it must stay open until
 * the worker has finished with the last chat handed to it. The set lives in storage, beside the
 * bulk sync state, because the service worker can be suspended between a hand-off and the
 * worker's report; the report arrives as a message that wakes it.
 */

import { getStorageAdapter } from "../../storage";

const PENDING_KEY = "bulkSyncPendingHandoffs";

export interface PendingHandoffs {
  /** Chat ids handed to the worker, without a report yet. */
  chatIds: string[];
  /** When the last hand-off or report happened (ms since epoch). */
  lastActivityAt: number;
  /**
   * The run's media files that were meant to be stored and were not (HVN-159): the sum of the
   * worker's reports so far. It lives here and not in the bulk sync state because a report settles
   * inside the queue below, while the tick loop writes that state at the same time.
   */
  unstoredMedia?: number;
}

const EMPTY: PendingHandoffs = { chatIds: [], lastActivityAt: 0 };

// Hand-offs and reports are read-modify-writes of one record, from two event handlers: they take
// turns.
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

// The last time any message came from the worker, in this service worker's lifetime. A worker that
// is busy with a large chat reports nothing for a while, but it keeps asking this side to fetch.
// It is also written to storage, at most every ACTIVITY_PERSIST_MS, so a service worker that was
// suspended still knows the worker spoke recently. Never initialise it to "now" at load: a service
// worker woken every 30 s by the alarm would then never see the silence, and the give-up would be
// unbounded.
let lastWorkerMessageAt = 0;
let lastPersistedAt = 0;
const ACTIVITY_PERSIST_MS = 10_000;

export function noteWorkerActivity(): void {
  const now = Date.now();
  lastWorkerMessageAt = now;
  if (now - lastPersistedAt < ACTIVITY_PERSIST_MS) return;
  lastPersistedAt = now;
  void exclusive(async () => {
    const current = await getPendingHandoffs();
    if (current.chatIds.length === 0) return;
    await getStorageAdapter().set(PENDING_KEY, {
      ...current,
      lastActivityAt: Math.max(current.lastActivityAt, now),
    });
  }).catch(() => undefined);
}

export async function getPendingHandoffs(): Promise<PendingHandoffs> {
  const stored = await getStorageAdapter().get<PendingHandoffs>(PENDING_KEY);
  return stored ?? EMPTY;
}

/** Milliseconds since the worker last did anything this side could see. */
export async function workerIdleMs(): Promise<number> {
  const { lastActivityAt } = await getPendingHandoffs();
  return Date.now() - Math.max(lastActivityAt, lastWorkerMessageAt);
}

export function addPendingHandoff(chatId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getPendingHandoffs();
    await getStorageAdapter().set(PENDING_KEY, {
      ...current,
      chatIds: [...current.chatIds.filter((id) => id !== chatId), chatId],
      lastActivityAt: Date.now(),
    });
  });
}

/**
 * The worker has reported on a chat. `unstoredMedia` is the number of its media files that were
 * not stored; it is added to the run's total here, in the queue, so two reports settled at once
 * both count.
 */
export function settlePendingHandoff(chatId: string, unstoredMedia = 0): Promise<void> {
  return exclusive(async () => {
    const current = await getPendingHandoffs();
    await getStorageAdapter().set(PENDING_KEY, {
      chatIds: current.chatIds.filter((id) => id !== chatId),
      lastActivityAt: Date.now(),
      unstoredMedia: (current.unstoredMedia ?? 0) + unstoredMedia,
    });
  });
}

/**
 * Forgets the hand-offs. `keepUnstoredMedia` is for a resume: the chats settled before the restart
 * stay settled, so their count stays too. The run's end reads the count first (`getPendingHandoffs`)
 * and then clears it all.
 */
export function clearPendingHandoffs(options?: { keepUnstoredMedia?: boolean }): Promise<void> {
  return exclusive(async () => {
    const kept = options?.keepUnstoredMedia ? ((await getPendingHandoffs()).unstoredMedia ?? 0) : 0;
    if (kept > 0) {
      await getStorageAdapter().set(PENDING_KEY, {
        chatIds: [],
        lastActivityAt: 0,
        unstoredMedia: kept,
      } satisfies PendingHandoffs);
      return;
    }
    await getStorageAdapter().remove(PENDING_KEY);
  });
}
