import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeLayoutInWorker } from "../src/constellation/runtime/workerClient";
import type { ChatEmbeddingRecord } from "../src/services/db";
import { getDB } from "../src/services/db";
import { setStarmapConfig } from "../src/services/settingsService";
import { computeStarmapLayoutFromEmbeddings } from "../src/services/starmapService";

vi.mock("../src/constellation/runtime/workerClient", () => ({
  computeLayoutInWorker: vi.fn(),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const EMPTY_LAYOUT = {
  points: [],
  bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
  stats: { pointCount: 0, clusterCount: 0, durationMs: 0, projection: "umap" as const },
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

beforeEach(async () => {
  await getDB().chatEmbeddings.clear();
  vi.mocked(computeLayoutInWorker).mockReset();
  vi.mocked(computeLayoutInWorker).mockResolvedValue(EMPTY_LAYOUT);
});

describe("computeStarmapLayoutFromEmbeddings (HVN-27)", () => {
  it("returns an empty layout, without calling the worker, when no chat has an embedding", async () => {
    const layout = await computeStarmapLayoutFromEmbeddings();

    expect(layout.points).toEqual([]);
    expect(computeLayoutInWorker).not.toHaveBeenCalled();
  });

  it("sends each stored vector with its chat id, and the layout settings as parameters", async () => {
    await setStarmapConfig({
      umapNeighbors: 9,
      umapMinDist: 0.3,
      umapSeed: 5,
      clusterMode: "manual",
      clusterK: 4,
    });
    await getDB().chatEmbeddings.bulkPut([
      embedding("chat-b", [0.1, 0.2]),
      embedding("chat-a", [0.3, 0.4]),
    ]);

    await computeStarmapLayoutFromEmbeddings();

    expect(computeLayoutInWorker).toHaveBeenCalledWith({
      vectors: [
        { chatId: "chat-a", vector: [0.3, 0.4] },
        { chatId: "chat-b", vector: [0.1, 0.2] },
      ],
      params: {
        umapNeighbors: 9,
        umapMinDist: 0.3,
        umapSeed: 5,
        clusterMode: "manual",
        clusterK: 4,
      },
    });
  });

  it("lets paramsOverride change only the parameters it names", async () => {
    await setStarmapConfig({
      umapNeighbors: 9,
      umapMinDist: 0.3,
      umapSeed: 5,
      clusterMode: "manual",
      clusterK: 4,
    });
    await getDB().chatEmbeddings.put(embedding("chat-a", [0.3, 0.4]));

    await computeStarmapLayoutFromEmbeddings({ paramsOverride: { umapSeed: 99 } });

    expect(computeLayoutInWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          umapNeighbors: 9,
          umapMinDist: 0.3,
          umapSeed: 99,
          clusterMode: "manual",
          clusterK: 4,
        },
      }),
    );
  });
});
