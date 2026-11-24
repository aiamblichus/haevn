import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveOperation } from "../src/background/state";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import { ChatRepository } from "../src/services/chatRepository";
import { getDB } from "../src/services/db";
import { JanitorService } from "../src/services/janitorService";
import { getMediaStorageService } from "../src/services/mediaStorage";
import { SearchIndexManager } from "../src/services/searchIndexManager";

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
    await getDB().chats.update("chat-doomed", { deleted: 1, deletedAt: Date.now() - 10 });
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

// HVN-138: the Janitor reads its ids, then deletes; a chat brought back in between is not deleted.
describe("ChatRepository.hardDeleteChats leaves a chat that is no longer soft-deleted", () => {
  let unindexed: string[];
  let dirsDeleted: string[];

  /** A chat with a row in every table the delete reaches. */
  async function seedFullChat(chatId: string, deleted: 0 | 1): Promise<void> {
    const db = getDB();
    await seedChat(chatId);
    await db.chats.update(
      chatId,
      deleted === 1 ? { deleted, deletedAt: Date.now() - 10 } : { deleted },
    );
    await db.chatMessages.put({
      id: "m1",
      chatId,
      childrenIds: [],
      message: [],
    } as unknown as ChatMessage);
    const thumbnailId = await db.thumbnails.add({
      chatId,
      messageId: "m1",
      source: "test",
      mediaType: "image/png",
      role: "user",
      thumbnail: "data:",
      chatTitle: chatId,
      generatedAt: 1,
    });
    await db.mediaContent.put({ id: thumbnailId, content: "media/x.png" });
    await db.chatMetadata.put({
      chatId,
      title: "t",
      description: "",
      synopsis: "",
      categories: [],
      keywords: [],
      source: "manual",
      updatedAt: 1,
    });
  }

  /** How many of the chat's rows exist, across every table the delete reaches. */
  async function rowsOf(chatId: string): Promise<number> {
    const db = getDB();
    const thumbnails = await db.thumbnails.where("chatId").equals(chatId).toArray();
    const rows = await Promise.all([
      db.chats.get(chatId),
      db.chatMessages.where("chatId").equals(chatId).first(),
      db.chatMetadata.get(chatId),
      db.chatEmbeddings.get(chatId),
      db.metadataQueue.get(chatId),
      db.embeddingQueue.get(chatId),
      ...thumbnails.map((t) => db.mediaContent.get(t.id as number)),
    ]);
    return rows.filter(Boolean).length + thumbnails.length;
  }

  beforeEach(async () => {
    const db = getDB();
    await Promise.all([
      db.chats.clear(),
      db.chatMessages.clear(),
      db.thumbnails.clear(),
      db.mediaContent.clear(),
      db.chatMetadata.clear(),
      db.chatEmbeddings.clear(),
      db.metadataQueue.clear(),
      db.embeddingQueue.clear(),
    ]);
    unindexed = [];
    dirsDeleted = [];
    vi.spyOn(SearchIndexManager, "removeChatsFromIndexBulk").mockImplementation(async (ids) => {
      unindexed.push(...ids);
    });
    vi.spyOn(getMediaStorageService(), "deleteChatDir").mockImplementation(async (id) => {
      dirsDeleted.push(id);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the chats that are still soft-deleted, with everything that belongs to them", async () => {
    await seedFullChat("gone", 1);

    const deleted = await ChatRepository.hardDeleteChats(["gone"]);

    expect(deleted).toEqual(["gone"]);
    expect(await rowsOf("gone")).toBe(0);
    expect(unindexed).toEqual(["gone"]);
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("keeps a chat whose deleted flag was cleared, rows, search entry and media folder", async () => {
    await seedFullChat("revived", 0);
    await seedFullChat("gone", 1);
    const before = await rowsOf("revived");
    expect(before).toBeGreaterThan(5);

    const deleted = await ChatRepository.hardDeleteChats(["revived", "gone"]);

    expect(deleted).toEqual(["gone"]);
    expect(await rowsOf("revived")).toBe(before);
    expect(await rowsOf("gone")).toBe(0);
    expect(unindexed).toEqual(["gone"]);
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("touches nothing when every chat was brought back or is missing", async () => {
    await seedFullChat("revived", 0);

    expect(await ChatRepository.hardDeleteChats(["revived", "never-existed"])).toEqual([]);

    expect(await getDB().chats.get("revived")).toBeDefined();
    expect(unindexed).toEqual([]);
    expect(dirsDeleted).toEqual([]);
  });

  it("does not delete a chat the restore brings back after the Janitor has read its ids", async () => {
    await seedFullChat("revived", 1);
    await seedFullChat("gone", 1);
    vi.spyOn(SearchIndexManager, "addOrUpdateChatInIndex").mockResolvedValue(undefined);
    const read = ChatRepository.getSoftDeletedChatIds;
    vi.spyOn(ChatRepository, "getSoftDeletedChatIds").mockImplementation(async (grace) => {
      const ids = await read(grace);
      // The undo lands between the Janitor's read and its delete.
      await ChatRepository.restoreChats(["revived"], 60_000);
      return ids;
    });

    const count = await JanitorService.cleanupSoftDeletedChats(0);

    expect(count).toBe(1);
    expect(await getDB().chats.get("revived")).toMatchObject({ deleted: 0 });
    expect(await getDB().chats.get("gone")).toBeUndefined();
    expect(dirsDeleted).toEqual(["gone"]);
  });

  // HVN-146: the Janitor waits for a restore, an import or a bulk sync.
  it.each([
    "import",
    "bulkSync",
    "bulkExport",
    "providerHealth",
  ] as const)("does nothing while %s holds the operation lock, and deletes at the next run", async (operation) => {
    await seedFullChat("gone", 1);
    await setActiveOperation(operation);
    try {
      expect(await JanitorService.cleanupSoftDeletedChats(0)).toBe(0);
      expect(await getDB().chats.get("gone")).toMatchObject({ deleted: 1 });
      expect(dirsDeleted).toEqual([]);
      expect(unindexed).toEqual([]);
    } finally {
      await setActiveOperation("idle");
    }

    expect(await JanitorService.cleanupSoftDeletedChats(0)).toBe(1);
    expect(await rowsOf("gone")).toBe(0);
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("keeps a chat that was deleted again, inside its undo window, after the Janitor read it", async () => {
    await seedFullChat("redeleted", 1);
    await seedFullChat("gone", 1);
    const db = getDB();
    await db.chats.update("redeleted", { deletedAt: Date.now() - 10 * 60_000 });
    await db.chats.update("gone", { deletedAt: Date.now() - 10 * 60_000 });
    vi.spyOn(SearchIndexManager, "addOrUpdateChatInIndex").mockResolvedValue(undefined);
    const read = ChatRepository.getSoftDeletedChatIds;
    vi.spyOn(ChatRepository, "getSoftDeletedChatIds").mockImplementation(async (grace) => {
      const ids = await read(grace);
      expect(ids.sort()).toEqual(["gone", "redeleted"]);
      // The person undoes the delete and deletes the chat again, between the read and the delete.
      await ChatRepository.restoreChats(["redeleted"], 60 * 60_000);
      await db.chats.update("redeleted", { deleted: 1, deletedAt: Date.now() });
      return ids;
    });

    const count = await JanitorService.cleanupSoftDeletedChats(5 * 60_000);

    expect(count).toBe(1);
    expect(await db.chats.get("redeleted")).toMatchObject({ deleted: 1 });
    expect(await db.chats.get("gone")).toBeUndefined();
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("keeps a chat that is brought back after hardDeleteChats was called and before its transaction opens", async () => {
    await seedFullChat("revived", 1);
    await seedFullChat("gone", 1);
    const db = getDB();
    // The chat comes back after hardDeleteChats was called and before its transaction opens. A
    // read made outside the transaction, ahead of this, would be stale by then.
    const transaction = db.transaction.bind(db) as (...args: unknown[]) => unknown;
    let revived = false;
    vi.spyOn(db, "transaction").mockImplementation((async (...args: unknown[]) => {
      if (!revived) {
        revived = true;
        await db.chats.update("revived", { deleted: 0 });
      }
      return transaction(...args);
    }) as never);
    const before = await rowsOf("revived");

    const deleted = await ChatRepository.hardDeleteChats(["revived", "gone"]);

    expect(deleted).toEqual(["gone"]);
    expect(await rowsOf("revived")).toBe(before);
    expect(await db.chats.get("revived")).toMatchObject({ deleted: 0 });
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("aborts the whole chunk when a step inside the transaction fails", async () => {
    await seedFullChat("a", 1);
    await seedFullChat("b", 1);
    const before = { a: await rowsOf("a"), b: await rowsOf("b") };
    // The last table the delete reaches before the chat rows: everything above it is done by then.
    vi.spyOn(getDB().embeddingQueue, "bulkDelete").mockRejectedValue(new Error("bad row"));

    await expect(ChatRepository.hardDeleteChats(["a", "b"])).rejects.toThrow(/bad row/);

    expect({ a: await rowsOf("a"), b: await rowsOf("b") }).toEqual(before);
    expect(before.a).toBeGreaterThan(5);
    expect(unindexed).toEqual([]);
    expect(dirsDeleted).toEqual([]);
  });

  it("deletes the other chunks when one chunk fails, then reports the failure", async () => {
    const db = getDB();
    const ids = Array.from({ length: 250 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    await db.chats.bulkPut(
      ids.map((id) => ({ ...buildChat(id), deleted: 1 as const, deletedAt: Date.now() - 10 })),
    );
    // The second chunk (c100 to c199) holds the bad row.
    const bulkDelete = db.chatEmbeddings.bulkDelete.bind(db.chatEmbeddings);
    vi.spyOn(db.chatEmbeddings, "bulkDelete").mockImplementation(async (keys: never) => {
      if ((keys as string[]).includes("c150")) throw new Error("bad row");
      return bulkDelete(keys);
    });

    await expect(ChatRepository.hardDeleteChats(ids)).rejects.toThrow(/bad row/);

    const left = (await db.chats.toArray()).map((c) => c.id).sort();
    expect(left).toEqual(ids.slice(100, 200));
    expect(unindexed.sort()).toEqual([...ids.slice(0, 100), ...ids.slice(200)]);
    expect(dirsDeleted.sort()).toEqual([...ids.slice(0, 100), ...ids.slice(200)]);
  });
});
