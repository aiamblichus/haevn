import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The worker talks through `self`; stand one in, import the module (which installs
// `self.onmessage`), and drive it with the messages the worker client sends.
type Posted = { type: string; requestId?: string; [key: string]: unknown };
type WorkerGlobal = {
  postMessage: (message: Posted) => void;
  onmessage?: (event: { data: unknown }) => void;
};

let posted: Posted[] = [];
let workerSelf: WorkerGlobal;

async function loadWorker(): Promise<void> {
  vi.resetModules();
  posted = [];
  workerSelf = { postMessage: (message) => posted.push(message) };
  vi.stubGlobal("self", workerSelf);
  await import("../src/services/starmap.worker");
}

function send(message: Record<string, unknown>): void {
  if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
  workerSelf.onmessage({ data: message });
}

const PARAMS = {
  umapNeighbors: 15,
  umapMinDist: 0.1,
  umapSeed: 42,
  clusterMode: "auto",
  clusterK: 12,
};

function vectors(count: number): Array<{ chatId: string; vector: number[] }> {
  return Array.from({ length: count }, (_, i) => ({
    chatId: `chat-${i}`,
    vector: [i % 3, (i * 7) % 5, i / 4, 1],
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("starmap worker (HVN-27)", () => {
  it("answers a layout request with the layout, under the same request id", async () => {
    await loadWorker();

    send({ type: "computeLayout", requestId: "req-1", vectors: vectors(12), params: PARAMS });

    const replies = posted.filter((m) => m.requestId === "req-1");
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe("layoutResult");
    expect(replies[0].points).toHaveLength(12);
  });

  it("answers a layout it cannot compute with an error for the same request, not silence", async () => {
    // The worker client waits up to 60 s for a reply, so a dropped error costs a minute.
    await loadWorker();
    const mixed = [
      { chatId: "a", vector: [1, 2] },
      { chatId: "b", vector: [1, 2, 3] },
    ];

    send({ type: "computeLayout", requestId: "req-2", vectors: mixed, params: PARAMS });

    const replies = posted.filter((m) => m.requestId === "req-2");
    expect(replies).toHaveLength(1);
    expect(replies[0].type).toBe("error");
    expect(String(replies[0].error)).toContain("same dimensionality");
  });
});
