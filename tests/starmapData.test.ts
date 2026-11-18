import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";

const computeStarmapLayoutFromEmbeddings = vi.hoisted(() => vi.fn());

vi.mock("../src/services/starmapService", () => ({ computeStarmapLayoutFromEmbeddings }));
vi.mock("../src/services/metadataService", () => ({}));
vi.mock("../src/services/settingsService", () => ({}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleGetStarmapData } from "../src/background/handlers/metadataHandlers";

function buildChat(id: string, overrides: Partial<Chat> = {}): Chat {
  return {
    id,
    source: "test",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: [],
    system: undefined,
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "synced",
    lastSyncAttemptMessage: undefined,
    deleted: 0,
    ...overrides,
  };
}

async function getStarmapData(): Promise<{
  points: Array<Record<string, unknown>>;
  [key: string]: unknown;
}> {
  const response = await new Promise<{ success: boolean; data?: never }>((resolve) => {
    void handleGetStarmapData({ action: "getStarmapData" }, resolve as never);
  });
  expect(response.success).toBe(true);
  return response.data as never;
}

async function getStarmapPoints(): Promise<Array<{ chatId: string }>> {
  const response = await new Promise<{ success: boolean; data?: { points: unknown[] } }>(
    (resolve) => {
      void handleGetStarmapData({ action: "getStarmapData" }, resolve as never);
    },
  );
  expect(response.success).toBe(true);
  return (response.data?.points ?? []) as Array<{ chatId: string }>;
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([db.chats.clear(), db.chatEmbeddings.clear()]);
  computeStarmapLayoutFromEmbeddings.mockReset();
});

describe("getStarmapData and soft-deleted chats", () => {
  it("leaves a soft-deleted chat off the starmap, though its embedding is still stored", async () => {
    await getDB().chats.bulkPut([
      buildChat("live"),
      buildChat("trashed", { deleted: 1, deletedAt: Date.now() }),
    ]);
    computeStarmapLayoutFromEmbeddings.mockResolvedValue({
      points: [
        { chatId: "live", x: 0, y: 0 },
        { chatId: "trashed", x: 1, y: 1 },
      ],
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
      stats: {},
    });

    const points = await getStarmapPoints();

    expect(points.map((p) => p.chatId)).toEqual(["live"]);
  });
});

describe("getStarmapData and the size of what reaches the page (HVN-93)", () => {
  // chrome.runtime messages are capped at 64 MiB; 2,500 chats x 1,536 dimensions of vectors
  // as JSON was about 70 MB. The page needs positions and labels, never the vectors.
  const CHATS = 300;
  const DIMENSIONS = 1536;
  const BYTES_PER_CHAT = 1000;

  it("sends positions and labels only: no vectors, and a size that grows with the chat count, not the dimension", async () => {
    const ids = Array.from({ length: CHATS }, (_, i) => `chat-${i}`);
    await getDB().chats.bulkPut(ids.map((id) => buildChat(id)));
    await getDB().chatEmbeddings.bulkPut(
      ids.map((chatId) => ({
        chatId,
        vector: Array.from({ length: DIMENSIONS }, (_, d) => (d % 7) / 7 + 0.123456789),
        vectorDim: DIMENSIONS,
        model: "test-embed",
        endpointHash: "endpoint",
        inputFingerprint: `fingerprint-${chatId}`,
        updatedAt: 1,
      })),
    );
    computeStarmapLayoutFromEmbeddings.mockResolvedValue({
      points: ids.map((chatId, i) => ({
        chatId,
        x: i / 7,
        y: i / 11,
        z: i / 13,
        clusterId: i % 8,
      })),
      bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
      stats: { pointCount: CHATS, clusterCount: 8, durationMs: 1, projection: "umap" },
    });

    const data = await getStarmapData();

    const json = JSON.stringify(data);
    expect(data.points).toHaveLength(CHATS);
    expect(json).not.toContain('"vector"');
    expect(data.embeddedCount).toBe(CHATS);
    expect(json.length).toBeLessThan(CHATS * BYTES_PER_CHAT);
  });
});
