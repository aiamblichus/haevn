import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HaevnDatabase } from "../src/services/db";

// Version 21 drops the `lunrIndex` table (HVN-89). An archive that was written at version 20 must
// come out of the upgrade with every other table and its rows.

/** The schema of version 20, as it shipped: the one this upgrade starts from. */
const VERSION_20 = {
  chats:
    "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title], deletedAt, deleted, [deleted+lastSyncedTimestamp], [deleted+providerLastModifiedTimestamp], [deleted+title], [deleted+source+lastSyncedTimestamp], [deleted+source+providerLastModifiedTimestamp], [deleted+source+title]",
  chatMessages: "[chatId+id], chatId, parentId, timestamp",
  lunrIndex: "id",
  openwebuiInstances: "id, baseUrl",
  cache: "id",
  thumbnails:
    "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
  mediaContent: "id",
  chatMetadata: "chatId",
  metadataQueue: "chatId, status, addedAt",
  chatEmbeddings: "chatId, updatedAt, [model+updatedAt]",
  embeddingQueue: "chatId, status, addedAt",
  starmapLayout: "layoutKey, updatedAt",
};

/** One row for each table of version 20, with a value in each indexed field it has. */
const ROWS: Record<keyof typeof VERSION_20, Record<string, unknown>> = {
  chats: {
    id: "c1",
    source: "claude",
    title: "A chat",
    lastSyncedTimestamp: 5,
    syncStatus: "synced",
    deleted: 0,
  },
  chatMessages: { chatId: "c1", id: "m1", parentId: null, timestamp: 7 },
  lunrIndex: { id: "segment_0", index: {}, meta: { docIds: ["c1"], timestamp: 1 } },
  openwebuiInstances: { id: "o1", baseUrl: "http://localhost:3000" },
  cache: { id: "provider-count:claude", value: 3, lastUpdated: 9 },
  thumbnails: {
    chatId: "c1",
    messageId: "m1",
    source: "claude",
    role: "user",
    mediaType: "image",
    generatedAt: 11,
  },
  mediaContent: { id: "media-1", data: "x" },
  chatMetadata: { chatId: "c1", title: "A chat" },
  metadataQueue: { chatId: "c1", status: "pending", addedAt: 13 },
  chatEmbeddings: { chatId: "c1", updatedAt: 15, model: "m", vector: [0.1], vectorDim: 1 },
  embeddingQueue: { chatId: "c1", status: "pending", addedAt: 17 },
  starmapLayout: { layoutKey: "k", updatedAt: 19, points: [] },
};

async function makeVersion20(): Promise<void> {
  const old = new Dexie("HaevnDB");
  old.version(20).stores(VERSION_20);
  await old.open();
  for (const [table, row] of Object.entries(ROWS)) {
    await old.table(table).put(row);
  }
  old.close();
}

function objectStoreNames(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("HaevnDB");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const names = [...request.result.objectStoreNames].sort();
      request.result.close();
      resolve(names);
    };
  });
}

describe("the upgrade to Dexie version 21 (HVN-89)", () => {
  let db: HaevnDatabase | undefined;

  beforeEach(async () => {
    await Dexie.delete("HaevnDB");
  });

  afterEach(async () => {
    db?.close();
    db = undefined;
    await Dexie.delete("HaevnDB");
  });

  it("starts from a database that has the table, so the test can fail", async () => {
    await makeVersion20();
    expect(await objectStoreNames()).toContain("lunrIndex");
  });

  it("drops lunrIndex and keeps every other table with its rows and indexes", async () => {
    await makeVersion20();

    db = new HaevnDatabase();
    await db.open();

    const kept = Object.keys(VERSION_20)
      .filter((table) => table !== "lunrIndex")
      .sort();
    expect(await objectStoreNames()).toEqual(kept);
    expect(db.tables.map((table) => table.name).sort()).toEqual(kept);

    for (const table of kept) {
      expect(await db.table(table).count(), `${table} rows`).toBe(1);
    }
    // A row that is read back, and one found through an index of its table.
    expect(await db.chats.get("c1")).toMatchObject({ title: "A chat", source: "claude" });
    expect(await db.chats.where("source").equals("claude").count()).toBe(1);
    expect(
      await db.chats
        .where("[deleted+source+lastSyncedTimestamp]")
        .between([0, "claude", 0], [0, "claude", 10])
        .count(),
    ).toBe(1);
    expect(await db.chatMessages.where("chatId").equals("c1").count()).toBe(1);
    expect(await db.cache.get("provider-count:claude")).toMatchObject({ value: 3 });
    expect(await db.thumbnails.where("[chatId+messageId]").equals(["c1", "m1"]).count()).toBe(1);
    expect(await db.chatEmbeddings.where("[model+updatedAt]").equals(["m", 15]).count()).toBe(1);
  });

  it("opens a database that is new at version 21 without the table", async () => {
    db = new HaevnDatabase();
    await db.open();
    expect(await objectStoreNames()).not.toContain("lunrIndex");
    expect(db.tables.map((table) => table.name)).not.toContain("lunrIndex");
  });
});
