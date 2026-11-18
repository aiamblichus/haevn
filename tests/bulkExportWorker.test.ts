import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportOptions } from "../src/formatters";
import type { HaevnDatabase } from "../src/services/db";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The worker opens its own database; keep each one so a test can hold or fail the chat loads.
const workerDbs = vi.hoisted(() => [] as HaevnDatabase[]);
vi.mock("../src/services/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/services/db")>();
  class TrackedDatabase extends original.HaevnDatabase {
    constructor() {
      super();
      workerDbs.push(this);
    }
  }
  return { ...original, HaevnDatabase: TrackedDatabase };
});

// Staging is OPFS; a start creates its staging directory, which is all these tests need from it.
const stagedExports = vi.hoisted(() => [] as string[]);
vi.mock("../src/services/exportStaging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/exportStaging")>()),
  ensureExportStagingDirectories: async (exportId: string) => {
    stagedExports.push(exportId);
  },
}));

// The worker talks through `self`; stand one in, import the module (which installs
// `self.onmessage`), and drive it with the messages the service worker sends.
type Posted = { type: string; requestId?: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
let workerSelf: WorkerGlobal;
let chatLoads: string[] = [];
// Chat "a0" waits on this before it answers; a test replaces it to hold the first batch.
let firstLoad: Promise<void> = Promise.resolve();

const EXPORT_REFUSED = "An export is already running in the worker.";
const OPTIONS = {} as ExportOptions;
const META = {
  haevnVersion: "test",
  exportVersion: "1",
  exportTimestamp: "2026-11-18T00:00:00.000Z",
};
// 101 chats make two batches; chat "a100" is the first of the second, and it fails to load.
const TWO_BATCHES = Array.from({ length: 101 }, (_, i) => `a${i}`);

async function loadWorker(): Promise<void> {
  vi.resetModules();
  posted = [];
  chatLoads = [];
  stagedExports.length = 0;
  firstLoad = Promise.resolve();
  workerSelf = { postMessage: (message) => posted.push(message) };
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/bulkExport/bulkExport.worker");

  const db = workerDbs.at(-1);
  if (!db) throw new Error("the worker did not open its database");
  vi.spyOn(db.chats, "get").mockImplementation(async (id: string) => {
    chatLoads.push(id);
    if (id === "a0") await firstLoad;
    if (id === "a100") throw new Error("boom");
    return undefined;
  });
}

/** Holds the first batch at its first chat until the returned function is called. */
function holdFirstLoad(): () => void {
  let release!: () => void;
  firstLoad = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}

function send(message: Record<string, unknown>): Promise<void> {
  if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
  return workerSelf.onmessage({ data: message });
}

function startMessage(requestId: string, exportId: string, chatIds: string[]) {
  return { type: "start", requestId, exportId, chatIds, options: OPTIONS, meta: META };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a second bulk export start while a job runs or is paused (HVN-55)", () => {
  it("refuses it, and the running job keeps its own batches", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    await send(startMessage("r2", "e2", ["b0", "b1", "b2"]));

    expect(posted).toContainEqual({ type: "error", error: EXPORT_REFUSED, requestId: "r2" });
    expect(stagedExports).toEqual(["e1"]);
    expect(chatLoads.filter((id) => id.startsWith("b"))).toEqual([]);

    release();
    await first;
    // The first job's second batch is its own: 101 chats in two batches, failing on its chat.
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: "progress",
        requestId: "r1",
        total: 101,
        totalBatches: 2,
        status: "Processing batch 2/2...",
      }),
    );
    expect(posted).toContainEqual({ type: "error", error: "boom", requestId: "r1" });
  });

  it("refuses it while the running job is paused", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    posted = [];
    await send({ type: "pause", requestId: "p1" });
    expect(posted).toEqual([{ type: "paused", requestId: "p1" }]);

    posted = [];
    await send(startMessage("r2", "e2", ["b0"]));
    expect(posted).toEqual([{ type: "error", error: EXPORT_REFUSED, requestId: "r2" }]);
    expect(stagedExports).toEqual(["e1"]);

    // The paused job ends at its batch boundary; cancel then clears it.
    release();
    await first;
    expect(posted).toContainEqual(expect.objectContaining({ type: "paused", requestId: "r1" }));
    posted = [];
    await send({ type: "cancel" });
    expect(posted).toEqual([expect.objectContaining({ type: "cancelled" })]);
  });

  it("accepts a start once the job has completed", async () => {
    await loadWorker();
    await send(startMessage("r1", "e1", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r1" }));

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted.some((m) => m.type === "error")).toBe(false);
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("accepts a start once the job has failed", async () => {
    await loadWorker();
    await send(startMessage("r1", "e1", TWO_BATCHES));
    expect(posted).toContainEqual({ type: "error", error: "boom", requestId: "r1" });

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });

  it("accepts a start once the job has been cancelled", async () => {
    await loadWorker();
    const release = holdFirstLoad();
    const first = send(startMessage("r1", "e1", TWO_BATCHES));
    await vi.waitFor(() => expect(chatLoads).toContain("a0"));

    await send({ type: "cancel" });
    expect(posted).toContainEqual(expect.objectContaining({ type: "cancelled" }));

    // The batch that was in flight when the cancel landed ends before the next start.
    release();
    await first;

    posted = [];
    await send(startMessage("r2", "e2", []));
    expect(posted).toContainEqual(expect.objectContaining({ type: "complete", requestId: "r2" }));
  });
});
