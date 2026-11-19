import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import { ChatRepository } from "../src/services/chatRepository";
import { getDB } from "../src/services/db";

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
  await db.chatEmbeddings.put({
    chatId,
    vector: [0.1, 0.2, 0.3],
    vectorDim: 3,
    model: "test-embedding",
    endpointHash: "endpoint",
    inputFingerprint: `fp-${chatId}`,
    updatedAt: 1704067200000,
  });
  await db.metadataQueue.put({ chatId, status: "pending", retries: 0, addedAt: 1704067200000 });
  await db.embeddingQueue.put({ chatId, status: "pending", retries: 0, addedAt: 1704067200000 });
}

describe("ChatRepository message reads take the table only (HVN-31)", () => {
  it("reads no messages from a row that still carries them inline", async () => {
    const inline = {
      id: "m1",
      chatId: "inline",
      childrenIds: [],
      message: [],
      model: "m",
      done: true,
      timestamp: 1,
    } as unknown as ChatMessage;
    await getDB().chats.put({ ...buildChat("inline"), messages: { m1: inline } });

    expect(await ChatRepository.getChatMessages("inline")).toEqual({});
    expect(await ChatRepository.getChatMessageCount("inline")).toBe(0);
    expect((await ChatRepository.getChatWithMessages("inline"))?.messages).toEqual({});
  });

  it("refuses a read of a chat whose messages are still in its row, naming the chat", async () => {
    const inline = {
      id: "m1",
      chatId: "held",
      childrenIds: [],
      message: [],
    } as unknown as ChatMessage;
    await getDB().chats.put({ ...buildChat("held"), messages: { m1: inline } });
    await getDB().chats.put({ ...buildChat("moved"), messages: {} });

    expect(await ChatRepository.unmovedRefusal("held")).toMatch(/^Chat held cannot be read yet/);
    expect(await ChatRepository.unmovedRefusal("moved")).toBeUndefined();
    expect(await ChatRepository.unmovedRefusal("missing")).toBeUndefined();
  });
});

describe("ChatRepository.hardDeleteChats", () => {
  beforeEach(async () => {
    const db = getDB();
    await Promise.all([
      db.chats.clear(),
      db.chatEmbeddings.clear(),
      db.metadataQueue.clear(),
      db.embeddingQueue.clear(),
    ]);
  });

  it("removes the embedding and queue rows of the deleted chat and keeps another chat's rows", async () => {
    await seedChat("chat-doomed");
    await seedChat("chat-kept");

    await ChatRepository.hardDeleteChats(["chat-doomed"]);

    const db = getDB();
    expect(await db.chats.get("chat-doomed")).toBeUndefined();
    expect(await db.chatEmbeddings.get("chat-doomed")).toBeUndefined();
    expect(await db.metadataQueue.get("chat-doomed")).toBeUndefined();
    expect(await db.embeddingQueue.get("chat-doomed")).toBeUndefined();

    expect(await db.chats.get("chat-kept")).toBeDefined();
    expect(await db.chatEmbeddings.get("chat-kept")).toBeDefined();
    expect(await db.metadataQueue.get("chat-kept")).toBeDefined();
    expect(await db.embeddingQueue.get("chat-kept")).toBeDefined();
  });
});
