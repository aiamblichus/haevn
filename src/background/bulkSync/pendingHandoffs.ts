/**
 * The chats a bulk sync has handed to the worker and the worker has not yet reported on (HVN-123).
 *
 * The extraction tab does the worker's media downloads (`fetchBlob`), so it must stay open until
 * the worker has finished with the last chat handed to it. The set lives in storage, beside the
 * bulk sync state, because the service worker can be suspended between a hand-off and the
 * worker's report; the report arrives as a message that wakes it.
 */

import { getStorageAdapter } from "../../storage";
import { getBulkSyncState, setBulkSyncState } from "../state";
import { syncRunId } from "./runId";
import type { BulkSyncState } from "./types";

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
  return exclusive(() => settleNow(chatId, unstoredMedia));
}

// The steps below run inside the queue and call no queued function: the queue is not re-entrant.

async function settleNow(chatId: string, unstoredMedia: number): Promise<void> {
  const current = await getPendingHandoffs();
  await getStorageAdapter().set(PENDING_KEY, {
    chatIds: current.chatIds.filter((id) => id !== chatId),
    lastActivityAt: Date.now(),
    unstoredMedia: (current.unstoredMedia ?? 0) + unstoredMedia,
  });
}

async function clearNow(keepUnstoredMedia: boolean): Promise<void> {
  const kept = keepUnstoredMedia ? ((await getPendingHandoffs()).unstoredMedia ?? 0) : 0;
  if (kept > 0) {
    await getStorageAdapter().set(PENDING_KEY, {
      chatIds: [],
      lastActivityAt: 0,
      unstoredMedia: kept,
    } satisfies PendingHandoffs);
    return;
  }
  await getStorageAdapter().remove(PENDING_KEY);
}

/**
 * A worker report for chat `chatId`, made under run `runId`, settles the chat only while that is
 * the stored run (HVN-127). The check, the settle and the record of a failure are one step of the
 * queue (HVN-160), and so is the resume's take-over (`takeOverRun`): a report is settled before the
 * resume reads the pending set, or refused after the resume has written its new count, never in
 * between, and two failures reported at once are both kept. A failure is recorded before the chat
 * leaves the pending set, so a write that fails between the two leaves the chat pending, not lost.
 * Returns false for a report of another run, which changes nothing.
 */
export function settleWorkerReport(report: {
  chatId: string;
  runId: string;
  unstoredMedia?: number;
  /** The worker failed the chat, and why. */
  failure?: { error: string };
}): Promise<boolean> {
  return exclusive(async () => {
    const state = await getBulkSyncState();
    if (!state || report.runId !== syncRunId(state)) return false;
    if (report.failure) {
      // Written from the state read above, with no await between the read and this write. The tick
      // loop writes the same record outside this queue, so a tick write that lands between the two
      // can still be overwritten: this narrows that window to one storage round trip, and does not
      // close it (the real fix is HVN-130).
      await setBulkSyncState({
        ...state,
        failedSyncs: [...state.failedSyncs, { chatId: report.chatId, error: report.failure.error }],
      });
    }
    await settleNow(report.chatId, report.unstoredMedia ?? 0);
    return true;
  });
}

/**
 * A resume takes the run over in one step of the queue (HVN-160). It reads the stored run, which
 * must still be `startedAt`'s and running or paused, and the pending set; `build` plans the resumed
 * run from both; the planned run is written, and then the hand-offs are forgotten, keeping the count
 * of media not stored. The order matters (HVN-169): a service worker that stops between the two
 * writes leaves the old hand-offs beside the planned run, and the next resume fetches their chats
 * again. Written the other way round, it would leave the old run with no hand-offs, and those chats
 * would count as settled. Returns null, and writes nothing, when the stored run can no longer be
 * resumed.
 */
export function takeOverRun<T extends { next: BulkSyncState }>(
  startedAt: number,
  build: (current: BulkSyncState, pendingChatIds: string[]) => T,
): Promise<T | null> {
  return exclusive(async () => {
    const current = await getBulkSyncState();
    if (
      !current ||
      current.startedAt !== startedAt ||
      (current.status !== "running" && current.status !== "paused")
    ) {
      return null;
    }
    const built = build(current, (await getPendingHandoffs()).chatIds);
    await setBulkSyncState(built.next);
    await clearNow(true);
    return built;
  });
}

/**
 * Forgets the hand-offs. `keepUnstoredMedia` is for a resume: the chats settled before the restart
 * stay settled, so their count stays too. The run's end reads the count first (`getPendingHandoffs`)
 * and then clears it all.
 */
export function clearPendingHandoffs(options?: { keepUnstoredMedia?: boolean }): Promise<void> {
  return exclusive(() => clearNow(options?.keepUnstoredMedia === true));
}
