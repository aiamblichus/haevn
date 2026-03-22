
import { describe, it, expect, beforeEach } from "vitest";
import Dexie from "dexie";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { HaevnDatabase, type Thumbnail } from "../src/services/db";

describe("Gallery Integrity (Soft Deletion)", () => {
  let db: HaevnDatabase;

  beforeEach(async () => {
    // Force set dependencies
    Dexie.dependencies.indexedDB = indexedDB;
    Dexie.dependencies.IDBKeyRange = IDBKeyRange;

    // Use native delete to avoid static method issues
    await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase("HaevnDB");
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error("blocked"));
    });

    db = new HaevnDatabase();
    await db.open();
  });

  it("should correctly identify and filter out thumbnails from soft-deleted chats", async () => {
    // 1. Setup Data
    const activeChatId = "chat-active-123";
    const deletedChatId = "chat-deleted-456";

    // Add Chats
    await db.chats.bulkAdd([
      {
        id: activeChatId,
        source: "chatgpt",
        title: "Active Chat",
        lastSyncedTimestamp: Date.now(),
        providerLastModifiedTimestamp: Date.now(),
        syncStatus: "synced",
        messages: {},
        deleted: 0
      },
      {
        id: deletedChatId,
        source: "claude",
        title: "Deleted Chat",
        lastSyncedTimestamp: Date.now(),
        providerLastModifiedTimestamp: Date.now(),
        syncStatus: "synced",
        messages: {},
        deleted: 1,
        deletedAt: Date.now()
      }
    ]);

    // Add Thumbnails
    // Note: The thumbnail worker doesn't check chat status during generation, 
    // so we simulate that state here.
    const now = Date.now();
    await db.thumbnails.bulkAdd([
      {
        chatId: activeChatId,
        messageId: "msg-1",
        source: "chatgpt",
        role: "user",
        mediaType: "image/png",
        thumbnail: "data:image/png;base64,fake",
        chatTitle: "Active Chat",
        generatedAt: now
      } as Thumbnail,
      {
        chatId: deletedChatId,
        messageId: "msg-2",
        source: "claude",
        role: "assistant",
        mediaType: "image/png",
        thumbnail: "data:image/png;base64,fake",
        chatTitle: "Deleted Chat",
        generatedAt: now
      } as Thumbnail
    ]);

    // 2. Run the Logic implemented in thumbnail.worker.ts

    // Step A: Get soft-deleted chat IDs
    const deletedChatIds = new Set(await db.chats.where("deleted").equals(1).primaryKeys());
    
    expect(deletedChatIds.has(deletedChatId)).toBe(true);
    expect(deletedChatIds.has(activeChatId)).toBe(false);

    // Step B: Fetch thumbnails and apply predicate
    // Simulating the worker's query logic
    const thumbnails = await db.thumbnails.toArray();
    
    const predicate = (t: Thumbnail) => {
      // Exclude soft-deleted chats
      if (deletedChatIds.has(t.chatId)) return false;
      return true;
    };

    const filteredThumbnails = thumbnails.filter(predicate);

    // 3. Assertions
    expect(filteredThumbnails.length).toBe(1);
    expect(filteredThumbnails[0].chatId).toBe(activeChatId);
    
    // Ensure the deleted one was actually there before filtering
    expect(thumbnails.length).toBe(2);
  });
});
