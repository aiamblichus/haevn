import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The bulk sync worker answers a sync request with a `progress` report for the chat. The report
// carries the run id of the request, success or failure, so that the service worker can tell a
// report for the run it is driving from a late one for an earlier run (HVN-127).
const { transform, saveChat } = vi.hoisted(() => ({ transform: vi.fn(), saveChat: vi.fn() }));

vi.mock("../src/background/utils/platformTransform", () => ({
  transformRawDataToHaevn: transform,
}));
vi.mock("../src/providers/index", () => ({ registerAllProviders: () => {} }));
vi.mock("../src/services/chatPersistence", () => ({ saveChat }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type Posted = { type: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => Promise<void>;
};

let posted: Posted[] = [];
const workerSelf: WorkerGlobal = { postMessage: (message) => posted.push(message) };

beforeAll(async () => {
  vi.stubGlobal("self", workerSelf);
  await import("../src/background/bulkSync/bulkSync.worker");
});

beforeEach(() => {
  posted = [];
  transform.mockReset();
  saveChat.mockReset();
  saveChat.mockResolvedValue({});
  // a new run: the worker forgets the runs it has seen
  void workerSelf.onmessage?.({ data: { type: "reset" } });
});

async function sync(chatId: string, runId: string): Promise<void> {
  await workerSelf.onmessage?.({
    data: {
      type: "sync",
      data: { chatId, platformName: "chatgpt", hostname: "chatgpt.com", rawData: {}, runId },
      requestId: "r1",
    },
  });
}

describe("the bulk sync worker's report", () => {
  it("echoes the run id of the request when the chat was saved", async () => {
    transform.mockResolvedValue([]);

    await sync("c1", "1700000000000:2");

    const reports = posted.filter((m) => m.type === "progress");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ chatId: "c1", success: true, runId: "1700000000000:2" });
  });

  it("echoes it when the chat failed, with the reason", async () => {
    transform.mockRejectedValue(new Error("download failed"));

    await sync("c2", "1700000000000:0");

    const reports = posted.filter((m) => m.type === "progress");
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      chatId: "c2",
      success: false,
      error: "download failed",
      runId: "1700000000000:0",
    });
  });

  it("keeps each request's id apart when two follow each other", async () => {
    transform.mockResolvedValue([]);

    await sync("c1", "1700000000000:0");
    await sync("c1", "1700000000000:1");

    expect(posted.filter((m) => m.type === "progress").map((m) => m.runId)).toEqual([
      "1700000000000:0",
      "1700000000000:1",
    ]);
  });
});

describe("a task that a newer run has asked for again does not save (HVN-127)", () => {
  const OLD = "1700000000000:0";
  const NEW = "1700000000000:1";
  const chat = { id: "c1", source: "chatgpt", sourceId: "c1", title: "t" };

  function postProcessed(): unknown[] {
    return posted.filter((m) => m.type === "postProcess");
  }

  it("saves only the newer task when both are on the chat at once", async () => {
    // the old task is still transforming (its media come through a tab that is gone) when the redo arrives
    let finishOld!: () => void;
    transform.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = () => resolve([chat]);
        }),
    );
    transform.mockResolvedValueOnce([chat]);

    const old = sync("c1", OLD);
    await vi.waitFor(() => expect(transform).toHaveBeenCalledTimes(1));
    await sync("c1", NEW);
    finishOld();
    await old;

    expect(saveChat).toHaveBeenCalledTimes(1);
    expect(postProcessed()).toHaveLength(1);
    // both still answer, each with its own id: the service worker ignores the old one
    expect(posted.filter((m) => m.type === "progress").map((m) => m.runId)).toEqual([NEW, OLD]);
  });

  it("drops an old task that arrives after the newer one", async () => {
    transform.mockResolvedValue([chat]);

    await sync("c1", NEW);
    await sync("c1", OLD);

    expect(saveChat).toHaveBeenCalledTimes(1);
    expect(postProcessed()).toHaveLength(1);
  });

  it("drops a late task of an earlier run once a later run has begun, whatever its resume count", async () => {
    transform.mockResolvedValue([chat]);
    // the worker was reset when run A ended; run B's first task sets the newest id
    await sync("c1", "1700000000500:0");

    await sync("c1", "1700000000000:7");

    expect(saveChat).toHaveBeenCalledTimes(1);
  });

  it("forgets the newest run when the run is over", async () => {
    transform.mockResolvedValue([chat]);
    await sync("c1", NEW);

    await workerSelf.onmessage?.({ data: { type: "reset" } });
    await sync("c1", OLD);

    expect(saveChat).toHaveBeenCalledTimes(2);
  });
});
