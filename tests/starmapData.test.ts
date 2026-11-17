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
