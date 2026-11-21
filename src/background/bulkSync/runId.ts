/**
 * The identity a bulk sync gives the chats it hands to the worker, and the worker echoes on its
 * report (HVN-127). Pure, so the worker (which has no chrome APIs) can import it too.
 *
 * It is the run's `startedAt` and, once the run has been resumed after a restart, the resume count:
 * what the worker was doing before the restart is redone, so its late reports must not settle or
 * fail the redo, and a tick that began before the resume must not write over it.
 */
export function syncRunId(state: { startedAt: number; resumeCount?: number }): string {
  return `${state.startedAt}:${state.resumeCount ?? 0}`;
}

function parseRunId(runId: string): [number, number] | null {
  const match = /^(\d+):(\d+)$/.exec(runId);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

/**
 * True when `runId` is from an earlier run, or an earlier stretch of the same run, than `newest`.
 * An id that is not in the form `syncRunId` writes is never called older: it is not ours to drop.
 */
export function isOlderRun(runId: string, newest: string): boolean {
  const a = parseRunId(runId);
  const b = parseRunId(newest);
  if (!a || !b) return false;
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}
