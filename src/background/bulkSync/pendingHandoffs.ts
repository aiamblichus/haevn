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
let lastWorkerMessageAt = 0;

export function noteWorkerActivity(): void {
  lastWorkerMessageAt = Date.now();
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
      chatIds: [...current.chatIds.filter((id) => id !== chatId), chatId],
      lastActivityAt: Date.now(),
    });
  });
}

export function settlePendingHandoff(chatId: string): Promise<void> {
  return exclusive(async () => {
    const current = await getPendingHandoffs();
    await getStorageAdapter().set(PENDING_KEY, {
      chatIds: current.chatIds.filter((id) => id !== chatId),
      lastActivityAt: Date.now(),
    });
  });
}

export function clearPendingHandoffs(): Promise<void> {
  return exclusive(async () => {
    await getStorageAdapter().remove(PENDING_KEY);
  });
}
