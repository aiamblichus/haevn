import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The bulk sync worker answers a sync request with a `progress` report for the chat. The report
// carries the run id of the request, success or failure, so that the service worker can tell a
// report for the run it is driving from a late one for an earlier run (HVN-127).
const { transform } = vi.hoisted(() => ({ transform: vi.fn() }));

vi.mock("../src/background/utils/platformTransform", () => ({
  transformRawDataToHaevn: transform,
}));
vi.mock("../src/providers/index", () => ({ registerAllProviders: () => {} }));
vi.mock("../src/services/chatPersistence", () => ({ saveChat: vi.fn(async () => ({})) }));
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

    await sync("c1", "run-a");
    await sync("c1", "run-b");

    expect(posted.filter((m) => m.type === "progress").map((m) => m.runId)).toEqual([
      "run-a",
      "run-b",
    ]);
  });
});
