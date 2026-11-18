import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportOptions } from "../src/formatters";
import type {
  BulkExportWorkerMessage,
  BulkExportWorkerResponse,
} from "../src/types/workerMessages";
import { log } from "../src/utils/logger";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const sentEvents = vi.hoisted(() => [] as { action: string }[]);
vi.mock("../src/background/utils/messageUtils", () => ({
  safeSendMessage: (message: { action: string }) => {
    sentEvents.push(message);
  },
}));

// The worker is on the other side of the offscreen document. A test plays it: it sees the
// messages the service worker sends it, and answers through the listener the start registered.
type Listener = (message: BulkExportWorkerResponse) => Promise<void>;
const worker = vi.hoisted(() => ({
  sent: [] as string[],
  listener: undefined as Listener | undefined,
  onCancel: undefined as (() => Promise<void>) | undefined,
  startOptions: undefined as { timeout?: number } | undefined,
}));
vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: async (
    _workerType: string,
    message: BulkExportWorkerMessage,
    options?: { onProgress?: Listener; timeout?: number },
  ) => {
    worker.sent.push(message.type);
    if (message.type === "start" && options?.onProgress) {
      worker.listener = options.onProgress;
      worker.startOptions = options as { timeout?: number };
    }
    if (message.type === "cancel") await worker.onCancel?.();
    return undefined;
  },
}));

const { startBulkExport, cancelBulkExport } = await import(
  "../src/background/bulkExport/bulkExport"
);
const { getActiveOperation, getBulkExportState } = await import("../src/background/state");
const { getExportJobState } = await import("../src/background/export/exportState");

const OPTIONS = {} as ExportOptions;
const CANCEL_GRACE_MS = 60;

beforeEach(() => {
  sentEvents.length = 0;
  vi.mocked(log.warn).mockClear();
  worker.sent.length = 0;
  worker.listener = undefined;
  worker.onCancel = undefined;
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async () => undefined,
      lastError: null,
    },
  });
});

/** A running export, as the orchestrator holds it while the worker works. */
async function startExport(): Promise<void> {
  await startBulkExport(["a", "b", "c"], OPTIONS);
  expect(await getActiveOperation()).toBe("bulkExport");
  expect(worker.listener).toBeDefined();
}

async function pauseExport(): Promise<void> {
  await worker.listener?.({ type: "paused" });
  expect((await getBulkExportState())?.status).toBe("paused");
}

const canceledEvents = () => sentEvents.filter((event) => event.action === "bulkExportCanceled");

describe("the start's listener (HVN-61)", () => {
  it("has no timeout, so a long or paused export still reports its end", async () => {
    await startExport();

    expect(worker.startOptions?.timeout).toBe(0);
  });
});

describe("cancelling a bulk export (HVN-61)", () => {
  it("releases the lock and clears the state when the worker never answers, paused", async () => {
    await startExport();
    await pauseExport();

    await cancelBulkExport(CANCEL_GRACE_MS);

    expect(worker.sent).toEqual(["start", "cancel"]);
    expect(await getBulkExportState()).toBeNull();
    expect(await getExportJobState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(canceledEvents()).toHaveLength(1);

    // The lock is free: another export starts.
    await startBulkExport(["d"], OPTIONS);
    expect(sentEvents.filter((event) => event.action === "bulkExportFailed")).toEqual([]);
    expect(await getActiveOperation()).toBe("bulkExport");
  });

  it("releases the lock and clears the state when the worker never answers, running", async () => {
    await startExport();

    await cancelBulkExport(CANCEL_GRACE_MS);

    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(canceledEvents()).toHaveLength(1);
  });

  it("leaves the cleanup to the worker's answer when it comes, and does it once", async () => {
    await startExport();
    await pauseExport();
    // The worker answers a cancel with `cancelled` on the start's listener, a moment later.
    worker.onCancel = async () => {
      setTimeout(() => void worker.listener?.({ type: "cancelled" }), 10);
    };

    await cancelBulkExport(500);

    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(canceledEvents()).toHaveLength(1);
    // It waited for the answer; it did not clean up on its own.
    expect(vi.mocked(log.warn).mock.calls.map(([message]) => message)).not.toContain(
      "[BulkExport] The worker did not answer the cancel, forcing cleanup",
    );
  });

  it.each([
    "cancelled",
    "complete",
    "error",
    "paused",
  ] as const)("ignores a late %s from an earlier export once a new one has started", async (late) => {
    await startExport();
    const earlier = worker.listener;
    await cancelBulkExport(CANCEL_GRACE_MS); // the worker is silent: forced cleanup
    await startBulkExport(["d", "e"], OPTIONS);
    expect(await getActiveOperation()).toBe("bulkExport");
    const current = await getExportJobState();
    sentEvents.length = 0;

    await earlier?.({ type: late, processed: 1, skipped: 0, error: "late" } as never);

    expect((await getBulkExportState())?.status).toBe("running");
    expect(await getExportJobState()).toEqual(current);
    expect(await getActiveOperation()).toBe("bulkExport");
    expect(sentEvents).toEqual([]);
  });

  it("does nothing when no export is running", async () => {
    await cancelBulkExport(CANCEL_GRACE_MS);

    expect(worker.sent).toEqual([]);
    expect(canceledEvents()).toEqual([]);
  });
});
