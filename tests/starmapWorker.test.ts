import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatEmbeddingRecord } from "../src/services/db";
import { getDB } from "../src/services/db";

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

// The worker answers asynchronously: it reads IndexedDB before it computes
async function replyTo(requestId: string): Promise<Posted> {
  await vi.waitFor(() => expect(posted.some((m) => m.requestId === requestId)).toBe(true), {
    timeout: 20000,
  });
  return posted.filter((m) => m.requestId === requestId)[0];
}

const PARAMS = {
  umapNeighbors: 15,
  umapMinDist: 0.1,
  umapSeed: 42,
  clusterMode: "auto",
  clusterK: 12,
};

function embedding(chatId: string, vector: number[]): ChatEmbeddingRecord {
  return {
    chatId,
    vector,
    vectorDim: vector.length,
    model: "test-embed",
    endpointHash: "endpoint",
    inputFingerprint: `fingerprint-${chatId}`,
    updatedAt: 1,
  };
}

function chatIdOf(i: number): string {
  return `chat-${String(i).padStart(4, "0")}`;
}

async function seedEmbeddings(count: number): Promise<void> {
  await getDB().chatEmbeddings.bulkPut(
    Array.from({ length: count }, (_, i) => embedding(chatIdOf(i), [i % 3, (i * 7) % 5, i / 4, 1])),
  );
}

beforeEach(async () => {
  await getDB().chatEmbeddings.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("starmap worker (HVN-27, HVN-93)", () => {
  it("lays out the embeddings stored in IndexedDB, from a request that carries only parameters", async () => {
    await seedEmbeddings(12);
    await loadWorker();

    send({ type: "computeLayout", requestId: "req-1", params: PARAMS });

    const reply = await replyTo("req-1");
    expect(reply.type).toBe("layoutResult");
    expect((reply.points as Array<{ chatId: string }>).map((p) => p.chatId)).toEqual(
      Array.from({ length: 12 }, (_, i) => chatIdOf(i)),
    );
  });

  it("reads the embeddings in batches, never the whole table in one call", async () => {
    await seedEmbeddings(250);
    await loadWorker();
    // loadWorker resets the module registry: spy on the database the worker now holds
    const workerDb = (await import("../src/services/db")).getDB();
    const bulkGet = vi.spyOn(workerDb.chatEmbeddings, "bulkGet");
    const toArray = vi.spyOn(workerDb.chatEmbeddings, "toArray");

    send({ type: "computeLayout", requestId: "req-batches", params: PARAMS });

    const reply = await replyTo("req-batches");
    expect(reply.type).toBe("layoutResult");
    expect(bulkGet.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const [keys] of bulkGet.mock.calls) {
      expect(keys.length).toBeLessThanOrEqual(200);
    }
    expect(bulkGet.mock.calls.reduce((total, [keys]) => total + keys.length, 0)).toBe(250);
    expect(toArray).not.toHaveBeenCalled();
  });

  it("answers an empty archive with an empty layout", async () => {
    await loadWorker();

    send({ type: "computeLayout", requestId: "req-empty", params: PARAMS });

    const reply = await replyTo("req-empty");
    expect(reply.type).toBe("layoutResult");
    expect(reply.points).toEqual([]);
  });

  it("answers a layout it cannot compute with an error for the same request, not silence", async () => {
    // The worker client waits up to 60 s for a reply, so a dropped error costs a minute.
    await getDB().chatEmbeddings.bulkPut([embedding("a", [1, 2]), embedding("b", [1, 2, 3])]);
    await loadWorker();

    send({ type: "computeLayout", requestId: "req-2", params: PARAMS });

    const reply = await replyTo("req-2");
    expect(reply.type).toBe("error");
    expect(String(reply.error)).toContain("same dimensionality");
  });
});
