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

vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: () => undefined }));

// What the service worker asks of the offscreen document, in the order it asks. `events` also
// takes what Chrome reports about the download, so a test can say what came before a delete.
const offscreen = vi.hoisted(() => ({
  events: [] as string[],
  deleteFails: false,
  createBlobUrlFails: false,
  swept: [] as (string | undefined)[],
}));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  createBlobUrlFromOffscreen: async (path: string) => {
    if (offscreen.createBlobUrlFails) throw new Error("no such file");
    offscreen.events.push(`blob:${path}`);
    return "blob:test";
  },
  revokeBlobUrlFromOffscreen: async () => {
    offscreen.events.push("revoke");
  },
  deleteExportFromOffscreen: async (exportId: string) => {
    offscreen.events.push(`delete:${exportId}`);
    if (offscreen.deleteFails) throw new Error("offscreen is gone");
  },
  sweepExportsFromOffscreen: async (keepExportId?: string) => {
    offscreen.swept.push(keepExportId);
    return [];
  },
}));

// The worker is on the other side of the offscreen document. A test plays it: it answers
// through the listener the start registered.
type Listener = (message: BulkExportWorkerResponse) => Promise<void>;
const worker = vi.hoisted(() => ({
  listener: undefined as Listener | undefined,
}));
vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: async (
    _workerType: string,
    message: BulkExportWorkerMessage,
    options?: { onProgress?: Listener },
  ) => {
    if (message.type === "start" && options?.onProgress) worker.listener = options.onProgress;
    return undefined;
  },
}));

const { startBulkExport, cancelBulkExport, sweepOrphanedExports } = await import(
  "../src/background/bulkExport/bulkExport"
);
const { getActiveOperation, getBulkExportState } = await import("../src/background/state");
const { getExportJobState, setExportJobState } = await import(
  "../src/background/export/exportState"
);

const OPTIONS = {} as ExportOptions;

/** Chrome's answers to chrome.downloads.search for the one download, in order, then the last. */
let downloadSteps: { state: "in_progress" | "complete"; bytesReceived: number }[] = [];

beforeEach(() => {
  offscreen.events.length = 0;
  offscreen.deleteFails = false;
  offscreen.createBlobUrlFails = false;
  offscreen.swept.length = 0;
  worker.listener = undefined;
  vi.mocked(log.warn).mockClear();
  downloadSteps = [{ state: "complete", bytesReceived: 100 }];
  let searches = 0;
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "test" }),
      sendMessage: async () => undefined,
      lastError: null,
    },
    downloads: {
      download: (_options: unknown, callback: (id: number) => void) => {
        offscreen.events.push("download");
        callback(7);
      },
      search: (_query: unknown, callback: (items: unknown[]) => void) => {
        const step = downloadSteps[Math.min(searches, downloadSteps.length - 1)];
        searches += 1;
        if (step.state === "complete") offscreen.events.push("download:complete");
        callback([{ id: 7, ...step }]);
      },
      onChanged: { addListener: () => undefined, removeListener: () => undefined },
    },
  });
});

/** A running export, as the orchestrator holds it while the worker works. Returns its id. */
async function startExport(): Promise<string> {
  await startBulkExport(["a", "b", "c"], OPTIONS);
  expect(await getActiveOperation()).toBe("bulkExport");
  const job = await getExportJobState();
  expect(job).not.toBeNull();
  return (job as { exportId: string }).exportId;
}

const deletes = () => offscreen.events.filter((event) => event.startsWith("delete:"));

describe("a completed bulk export (HVN-62)", () => {
  it("deletes its directory once the download has settled and the blob URL is revoked", async () => {
    const exportId = await startExport();
    // Chrome is still receiving the ZIP at the first looks, and has it a second later.
    downloadSteps = [
      { state: "in_progress", bytesReceived: 10 },
      { state: "in_progress", bytesReceived: 50 },
      { state: "complete", bytesReceived: 100 },
    ];

    await worker.listener?.({ type: "complete", processed: 3, skipped: 0, batches: 1 });
    // The job is over for the service worker at once, and the ZIP is still needed.
    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
    expect(deletes()).toEqual([]);

    await vi.waitFor(() => expect(deletes()).toEqual([`delete:${exportId}`]), { timeout: 3000 });
    expect(offscreen.events).toEqual([
      `blob:exports/${exportId}/haevn_export.zip`,
      "download",
      "download:complete",
      "revoke",
      `delete:${exportId}`,
    ]);
  });

  it("deletes its directory when the download could not even be started", async () => {
    const exportId = await startExport();
    offscreen.createBlobUrlFails = true;

    await worker.listener?.({ type: "complete", processed: 3, skipped: 0, batches: 1 });

    await vi.waitFor(() => expect(deletes()).toEqual([`delete:${exportId}`]));
    expect(offscreen.events).not.toContain("download");
  });

  it("is still complete when the delete fails, and says so in the log", async () => {
    await startExport();
    offscreen.deleteFails = true;

    await worker.listener?.({ type: "complete", processed: 3, skipped: 0, batches: 1 });

    await vi.waitFor(() =>
      expect(
        vi
          .mocked(log.warn)
          .mock.calls.some(([message]) => String(message).includes("Failed to delete")),
      ).toBe(true),
    );
    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
  });
});

describe("a failed or cancelled bulk export (HVN-62)", () => {
  it("deletes the directory of an export the worker reports failed", async () => {
    const exportId = await startExport();

    await worker.listener?.({ type: "error", error: "zip failed" });

    expect(deletes()).toEqual([`delete:${exportId}`]);
    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
  });

  it("deletes the directory of an export the worker reports cancelled", async () => {
    const exportId = await startExport();

    await worker.listener?.({ type: "cancelled" });

    expect(deletes()).toEqual([`delete:${exportId}`]);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("deletes the directory when the cancel is forced because the worker is silent", async () => {
    const exportId = await startExport();

    await cancelBulkExport(40);

    expect(deletes()).toEqual([`delete:${exportId}`]);
    expect(await getBulkExportState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
  });

  it("deletes the directory of a paused export that is cancelled", async () => {
    const exportId = await startExport();
    await worker.listener?.({ type: "paused" });
    expect((await getBulkExportState())?.status).toBe("paused");

    await worker.listener?.({ type: "cancelled" });

    expect(deletes()).toEqual([`delete:${exportId}`]);
  });

  it("still releases the lock and the state when the delete fails", async () => {
    await startExport();
    offscreen.deleteFails = true;

    await worker.listener?.({ type: "cancelled" });

    expect(await getBulkExportState()).toBeNull();
    expect(await getExportJobState()).toBeNull();
    expect(await getActiveOperation()).toBe("idle");
  });

  it("deletes nothing of the current export when an earlier export's late message is ignored", async () => {
    await startExport();
    const earlier = worker.listener;
    await cancelBulkExport(40);
    offscreen.events.length = 0;
    await startBulkExport(["d"], OPTIONS);

    await earlier?.({ type: "cancelled" });

    expect(deletes()).toEqual([]);
  });
});

describe("the sweep of stale exports (HVN-62)", () => {
  const job = (status: "running" | "paused" | "cancelled" | "error") => ({
    exportId: "e-job",
    status,
    totalChats: 1,
    processedChats: 0,
    processedMedia: 0,
    bytesWritten: 0,
    startedAt: 1,
    lastCheckpointAt: 1,
    stagingRoot: "exports/e-job/staging",
    zipPath: "exports/e-job/haevn_export.zip",
    manifestPaths: { meta: "", chats: "", media: "" },
  });

  beforeEach(async () => {
    await setExportJobState(null);
  });

  it("sweeps with nothing to keep when no export is recorded", async () => {
    await sweepOrphanedExports();

    expect(offscreen.swept).toEqual([undefined]);
  });

  it.each(["running", "paused"] as const)("keeps the export of a %s job", async (status) => {
    await setExportJobState(job(status));

    await sweepOrphanedExports();

    expect(offscreen.swept).toEqual(["e-job"]);
  });

  it.each([
    "cancelled",
    "error",
  ] as const)("keeps nothing for a %s job: the export is over and may be swept", async (status) => {
    await setExportJobState(job(status));

    await sweepOrphanedExports();

    expect(offscreen.swept).toEqual([undefined]);
  });
});
