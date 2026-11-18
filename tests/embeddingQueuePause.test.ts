import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleSetStarmapConfig } from "../src/background/handlers/metadataHandlers";
import { getDB } from "../src/services/db";
import {
  EMBEDDING_PROCESS_ALARM,
  EMBEDDING_REFRESH_ALARM,
  METADATA_PROCESS_ALARM,
  METADATA_REFRESH_ALARM,
  pauseEmbeddingQueue,
  processEmbeddingQueueTick,
} from "../src/services/metadataService";
import { setMetadataAIConfig, setStarmapConfig } from "../src/services/settingsService";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const EMBEDDING_URL = "https://embeddings.test/v1";

type SetStarmapRequest = Parameters<typeof handleSetStarmapConfig>[0];

/** Send a starmap settings change through the same handler the options page uses. */
async function setStarmap(config: Record<string, unknown>): Promise<unknown> {
  const sendResponse = vi.fn();
  await handleSetStarmapConfig(
    { action: "setStarmapConfig", config } as SetStarmapRequest,
    sendResponse,
  );
  return sendResponse.mock.calls[0]?.[0];
}

/** A fetch that answers an embedding request with one vector. */
function stubEmbeddingApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([
    db.chatMetadata.clear(),
    db.embeddingQueue.clear(),
    db.chatEmbeddings.clear(),
  ]);
  await db.chatMetadata.put({
    chatId: "chat-1",
    title: "A chat",
    description: "About it",
    synopsis: "",
    categories: [],
    keywords: [],
    source: "manual",
    updatedAt: Date.now(),
  });
  await setMetadataAIConfig({ enabled: true });
  await setStarmapConfig({
    enabled: true,
    embeddingsEnabled: true,
    embeddingUrl: EMBEDDING_URL,
    embeddingModel: "test-embed",
    autoEmbedOnMetadataChange: true,
  });
  // An item the embedding tick had picked up when the pause arrives.
  await db.embeddingQueue.put({ chatId: "chat-1", status: "processing", retries: 0, addedAt: 1 });
});

afterEach(() => {
  // Restores the fetch and alarm spies; the chrome stub from tests/setup.ts stays in place.
  vi.restoreAllMocks();
});

describe("embedding queue pausing (049a22c)", () => {
  it("pausing moves an in-flight item back to pending and clears the embedding alarms only", async () => {
    const clear = vi.spyOn(chrome.alarms, "clear");

    await pauseEmbeddingQueue();

    expect((await getDB().embeddingQueue.get("chat-1"))?.status).toBe("pending");
    expect(clear).toHaveBeenCalledWith(EMBEDDING_PROCESS_ALARM);
    expect(clear).toHaveBeenCalledWith(EMBEDDING_REFRESH_ALARM);
    expect(clear).not.toHaveBeenCalledWith(METADATA_PROCESS_ALARM);
    expect(clear).not.toHaveBeenCalledWith(METADATA_REFRESH_ALARM);
  });

  it("while embeddings are off, a tick sends no request and returns the in-flight item to pending", async () => {
    const fetchMock = stubEmbeddingApi();
    await setStarmapConfig({ embeddingsEnabled: false });

    await processEmbeddingQueueTick();

    expect(fetchMock).not.toHaveBeenCalled();
    // A pause is not a failed attempt: the item goes back with no retry counted and no error.
    expect(await getDB().embeddingQueue.get("chat-1")).toMatchObject({
      status: "pending",
      retries: 0,
    });
  });

  it("switching the starmap off through the settings handler pauses the queue", async () => {
    const clear = vi.spyOn(chrome.alarms, "clear");

    expect(await setStarmap({ embeddingsEnabled: false })).toEqual({ success: true });

    expect((await getDB().embeddingQueue.get("chat-1"))?.status).toBe("pending");
    expect(clear).toHaveBeenCalledWith(EMBEDDING_PROCESS_ALARM);
  });

  it("switching it back on re-arms the embedding alarm, and the paused item is embedded", async () => {
    const fetchMock = stubEmbeddingApi();
    const create = vi.spyOn(chrome.alarms, "create");
    await setStarmap({ embeddingsEnabled: false });

    expect(await setStarmap({ embeddingsEnabled: true })).toEqual({ success: true });
    expect(create).toHaveBeenCalledWith(
      EMBEDDING_PROCESS_ALARM,
      expect.objectContaining({ delayInMinutes: 0.1 }),
    );

    await processEmbeddingQueueTick();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${EMBEDDING_URL}/embeddings`);
    expect(await getDB().chatEmbeddings.get("chat-1")).toMatchObject({
      model: "test-embed",
      vectorDim: 3,
      vector: [0.1, 0.2, 0.3],
    });
    expect(await getDB().embeddingQueue.get("chat-1")).toBeUndefined();
  });
});
