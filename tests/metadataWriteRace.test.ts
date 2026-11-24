import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import type { StoredChatMessage } from "../src/services/db";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";
import {
  generateForChat,
  processEmbeddingQueueTick,
  processQueueTick,
  setManualMetadata,
} from "../src/services/metadataService";
import { setMetadataAIConfig, setStarmapConfig } from "../src/services/settingsService";

// HVN-139: a generation that is in flight (the model is answering, the vector is being made) must
// not write over what was written to the chat's metadata in the meantime.

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const META_URL = "https://meta.test/v1";
const EMBED_URL = "https://embed.test/v1";

function buildChat(id: string): Chat {
  return {
    id,
    source: "test",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["test-model"],
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
  };
}

async function seedChat(chatId: string): Promise<void> {
  const db = getDB();
  await db.chats.put(buildChat(chatId));
  await db.chatMessages.put({
    id: "m1",
    chatId,
    childrenIds: [],
    message: [{ kind: "request", parts: [{ part_kind: "user-prompt", content: "What is tea?" }] }],
    model: "test-model",
    done: true,
    timestamp: 1704067200000,
  } as unknown as StoredChatMessage);
}

/**
 * Stands in for the model. `whileAnswering` runs once the request is out and before the reply
 * comes back: the moment another writer gets in.
 */
function stubModel(whileAnswering: () => Promise<void>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await whileAnswering();
    const answer = {
      title: "Generated title",
      description: "Generated.",
      synopsis: "Generated synopsis.",
      categories: [],
      keywords: ["tea"],
    };
    return new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  });
}

beforeEach(async () => {
  const db = getDB();
  await Promise.all([
    db.chats.clear(),
    db.chatMessages.clear(),
    db.chatMetadata.clear(),
    db.metadataQueue.clear(),
    db.embeddingQueue.clear(),
    db.chatEmbeddings.clear(),
  ]);
  await setMetadataAIConfig({
    enabled: true,
    url: META_URL,
    model: "meta-a",
    categories: [],
    extraRequestParams: {},
    indexMissing: false,
  });
  await setStarmapConfig({
    enabled: true,
    embeddingsEnabled: true,
    embeddingUrl: EMBED_URL,
    embeddingModel: "embed-a",
    autoEmbedOnMetadataChange: true,
    umapSeed: 42,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a metadata generation that finishes after the metadata was written", () => {
  it("leaves the record a restore wrote and returns it", async () => {
    await seedChat("c1");
    stubModel(async () => {
      await MetadataRepository.set("c1", { title: "Restored title", source: "manual" });
    });

    const record = await generateForChat("c1");

    expect(record).toMatchObject({ title: "Restored title", source: "manual" });
    expect(await MetadataRepository.get("c1")).toMatchObject({
      title: "Restored title",
      source: "manual",
    });
  });

  it("leaves a person's edit, and the queue tick takes the chat off the queue", async () => {
    await seedChat("c1");
    await getDB().metadataQueue.put({ chatId: "c1", status: "pending", retries: 0, addedAt: 1 });
    stubModel(async () => {
      await setManualMetadata("c1", { title: "Mine" });
    });

    await processQueueTick();

    expect(await MetadataRepository.get("c1")).toMatchObject({ title: "Mine", source: "manual" });
    expect(await getDB().metadataQueue.get("c1")).toBeUndefined();
  });

  it("writes when nothing was written meanwhile", async () => {
    await seedChat("c1");
    stubModel(async () => {});

    expect(await generateForChat("c1")).toMatchObject({ title: "Generated title", source: "ai" });
  });

  it("replaces a record that was there when it started and is unchanged (a regenerate)", async () => {
    await seedChat("c1");
    await MetadataRepository.set("c1", { title: "Old", source: "ai" });
    stubModel(async () => {});

    expect(await generateForChat("c1")).toMatchObject({ title: "Generated title", source: "ai" });
  });

  it("does not write over a record that was changed while it regenerated", async () => {
    await seedChat("c1");
    await MetadataRepository.set("c1", { title: "Old", source: "ai" });
    // An older updatedAt than the new write, so the change is seen even within one millisecond.
    await getDB().chatMetadata.update("c1", { updatedAt: 1 });
    stubModel(async () => {
      await MetadataRepository.set("c1", { title: "Edited", source: "manual" });
    });

    expect(await generateForChat("c1")).toMatchObject({ title: "Edited", source: "manual" });
  });
});

describe("an embedding that is made after the metadata changed", () => {
  async function putMetadata(title: string): Promise<void> {
    await getDB().chatMetadata.put({
      chatId: "c1",
      title,
      description: "About it",
      synopsis: "",
      categories: [],
      keywords: [],
      source: "manual",
      updatedAt: Date.now(),
    });
  }

  function stubEmbeddingApi(whileAnswering: () => Promise<void>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      await whileAnswering();
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      return new Response(
        JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })) }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
  }

  it("is not stored for the new text, and the chat is embedded again", async () => {
    await putMetadata("First title");
    await getDB().embeddingQueue.put({ chatId: "c1", status: "pending", retries: 0, addedAt: 1 });
    stubEmbeddingApi(async () => {
      await putMetadata("Second title");
    });

    await processEmbeddingQueueTick();

    expect(await getDB().chatEmbeddings.get("c1")).toBeUndefined();
    expect(await getDB().embeddingQueue.get("c1")).toMatchObject({ status: "pending" });

    // The next tick embeds the text as it is now.
    stubEmbeddingApi(async () => {});
    await processEmbeddingQueueTick();

    expect(await getDB().chatEmbeddings.get("c1")).toMatchObject({ vectorDim: 3 });
    expect(await getDB().embeddingQueue.get("c1")).toBeUndefined();
  });

  it("is stored, and the chat leaves the queue, when the metadata did not change", async () => {
    await putMetadata("First title");
    await getDB().embeddingQueue.put({ chatId: "c1", status: "pending", retries: 0, addedAt: 1 });
    stubEmbeddingApi(async () => {});

    await processEmbeddingQueueTick();

    expect(await getDB().chatEmbeddings.get("c1")).toMatchObject({ vectorDim: 3 });
    expect(await getDB().embeddingQueue.get("c1")).toBeUndefined();
  });
});
