import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerType } from "../src/utils/workerApi";

// The real workerApi, with the chrome runtime stubbed: a test plays the offscreen document by
// sending `workerMessage` events to the listener workerApi registers, on the requestId of the
// request it was sent.
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: async () => undefined,
}));

type Message = { type: string; requestId?: string; [key: string]: unknown };

let onMessage: ((message: unknown) => void) | undefined;
let sentRequestIds: (string | undefined)[] = [];

async function loadWorkerApi(): Promise<typeof import("../src/utils/workerApi")> {
  vi.resetModules();
  onMessage = undefined;
  sentRequestIds = [];
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      onMessage: {
        addListener: (listener: (message: unknown) => void) => {
          onMessage = listener;
        },
      },
      sendMessage: (message: { requestId?: string }) => {
        sentRequestIds.push(message.requestId);
      },
    },
  });
  return await import("../src/utils/workerApi");
}

/** The offscreen document forwarding a worker message. */
function fromWorker(message: Message): void {
  onMessage?.({ type: "workerMessage", data: message });
}

/** Start a long job the way the orchestrators do, and note what its listener is given. */
async function startJob(
  workerType: WorkerType,
  timeout?: number,
): Promise<{ seen: string[]; id: string; settled: () => boolean; rejected: () => boolean }> {
  const { sendWorkerRequest } = await import("../src/utils/workerApi");
  const seen: string[] = [];
  let done = false;
  let failed = false;
  const request = sendWorkerRequest(
    workerType,
    { type: "start" } as never,
    { onProgress: (data: unknown) => seen.push((data as Message).type), timeout } as never,
  );
  request.then(
    () => {
      done = true;
    },
    () => {
      done = true;
      failed = true;
    },
  );
  // The request registers its listener after awaiting the offscreen document. (Not waitFor:
  // under fake timers that would advance them.)
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(sentRequestIds).toHaveLength(1);
  return { seen, id: sentRequestIds[0] as string, settled: () => done, rejected: () => failed };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the listener of a long job (HVN-61)", () => {
  it("lives through a pause: what a resumed export posts still reaches it", async () => {
    await loadWorkerApi();
    const job = await startJob("bulkExport");

    fromWorker({ type: "progress", requestId: job.id });
    fromWorker({ type: "paused", requestId: job.id });
    // The job is resumed: its batches, and then its end, arrive on the same requestId.
    fromWorker({ type: "progress", requestId: job.id });
    fromWorker({ type: "complete", requestId: job.id });

    expect(job.seen).toEqual(["progress", "paused", "progress", "complete"]);
    await vi.waitFor(() => expect(job.settled()).toBe(true));
  });

  it("ends at cancelled, complete and error", async () => {
    for (const end of ["cancelled", "complete", "error"]) {
      await loadWorkerApi();
      const job = await startJob("bulkExport");
      fromWorker({ type: end, requestId: job.id, error: "boom" });
      fromWorker({ type: "progress", requestId: job.id });
      await vi.waitFor(() => expect(job.settled()).toBe(true));
      expect(job.seen).toEqual([end]);
    }
  });
});

describe("the timeout of a long job's listener (HVN-61)", () => {
  const A_DAY = 24 * 60 * 60 * 1000;

  it("does not run out when it is 0: a job paused for a day still ends on its listener", async () => {
    vi.useFakeTimers();
    await loadWorkerApi();
    const job = await startJob("bulkExport", 0);

    fromWorker({ type: "paused", requestId: job.id });
    await vi.advanceTimersByTimeAsync(A_DAY);
    expect(job.settled()).toBe(false);
    fromWorker({ type: "complete", requestId: job.id });

    expect(job.seen).toEqual(["paused", "complete"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.settled()).toBe(true);
    expect(job.rejected()).toBe(false);
  });

  it("still runs out when it is set: the request rejects and the listener is gone", async () => {
    vi.useFakeTimers();
    await loadWorkerApi();
    const job = await startJob("bulkExport", 1000);

    await vi.advanceTimersByTimeAsync(1001);
    expect(job.rejected()).toBe(true);
    fromWorker({ type: "complete", requestId: job.id });
    expect(job.seen).toEqual([]);
  });
});
