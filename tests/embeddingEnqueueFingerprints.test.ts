import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDB } from "../src/services/db";
import {
  enqueueAllMissingEmbeddings,
  processEmbeddingQueueTick,
} from "../src/services/metadataService";
import { setMetadataAIConfig, setStarmapConfig } from "../src/services/settingsService";
import { MESSAGE_MIGRATION_FLAG } from "../src/services/messageMigrationFlag";
import { getStorageAdapter } from "../src/storage";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const EMBEDDING_URL = "https://embeddings.test/v1";

/** Answers each embedding request with one vector per input, in order. */
function stubEmbeddingApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    const { input } = JSON.parse(String(init?.body)) as { input: string[] };
    return new Response(
      JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
}

async function putChat(chatId: string, title: string): Promise<void> {
  await getDB().chatMetadata.put({
    chatId,
    title,
    description: "About it",
    synopsis: "",
    categories: [],
    keywords: [],
    source: "manual",
    updatedAt: Date.now(),
  });
}

beforeEach(async () => {
  const db = getDB();
  // The store is one whose move of messages has run (HVN-31), so the tick is not held.
  await getStorageAdapter().set(MESSAGE_MIGRATION_FLAG, "done");
  await Promise.all([
    db.chatMetadata.clear(),
    db.embeddingQueue.clear(),
    db.chatEmbeddings.clear(),
  ]);
  await setMetadataAIConfig({ enabled: true });
  await setStarmapConfig({
    enabled: true,
    embeddingsEnabled: true,
    embeddingUrl: EMBEDDING_URL,
    embeddingModel: "test-embed",
    autoEmbedOnMetadataChange: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enqueueAllMissingEmbeddings", () => {
  it("queues a stale or missing embedding, leaves an up-to-date one, and reads no vectors", async () => {
    const db = getDB();
    await putChat("fresh", "Fresh title");
    await putChat("stale", "Old title");
    expect(await enqueueAllMissingEmbeddings()).toBe(2);

    // The real pipeline writes the embeddings, so the stored fingerprints are the production ones.
    stubEmbeddingApi();
    await processEmbeddingQueueTick();
    expect(await db.embeddingQueue.count()).toBe(0);
    expect(await db.chatEmbeddings.count()).toBe(2);

    // "stale" changes after its embedding was made; "missing" never had one.
    await putChat("stale", "New title");
    await putChat("missing", "Never embedded");

    const bulkGet = vi.spyOn(db.chatEmbeddings, "bulkGet");
    const toArray = vi.spyOn(db.chatEmbeddings, "toArray");

    expect(await enqueueAllMissingEmbeddings()).toBe(2);
    const queued = (await db.embeddingQueue.toArray()).map((item) => item.chatId).sort();
    expect(queued).toEqual(["missing", "stale"]);

    // The comparison reads only the fields it needs, so the vectors are never loaded in bulk.
    expect(bulkGet).not.toHaveBeenCalled();
    expect(toArray).not.toHaveBeenCalled();
  });
});
