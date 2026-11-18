import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { ChatRepository } from "../src/services/chatRepository";
import { ChatService } from "../src/services/chatService";
import { getDB } from "../src/services/db";
import { SearchIndexManager } from "../src/services/searchIndexManager";
import { SOFT_DELETE_GRACE_MS } from "../src/types/messaging";

function buildChat(id: string): Chat {
  return {
    id,
    source: "claude",
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
    deleted: 0,
  };
}

const CLAUDE_COUNT_KEY = "provider-count:claude";

describe("undoing a delete (ChatService.restoreChatsWithCleanup)", () => {
  let indexed: string[];

  beforeEach(async () => {
    const db = getDB();
    await Promise.all([db.chats.clear(), db.cache.clear()]);
    // A fresh count, so the delete and the undo move it and nothing recalculates it.
    await db.cache.put({ id: CLAUDE_COUNT_KEY, value: 5, lastUpdated: Date.now() });
    indexed = [];
    vi.spyOn(SearchIndexManager, "addOrUpdateChatInIndex").mockImplementation(async (chatId) => {
      indexed.push(chatId);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("brings a chat back inside the grace period, indexes it again and counts it again", async () => {
    const db = getDB();
    await db.chats.put(buildChat("chat-a"));

    await ChatService.deleteChatsWithCleanup(["chat-a"]);
    expect(await ChatRepository.getChat("chat-a")).toBeUndefined();
    expect((await db.cache.get(CLAUDE_COUNT_KEY))?.value).toBe(4);

    expect(await ChatService.restoreChatsWithCleanup(["chat-a"])).toEqual(["chat-a"]);

    const row = await db.chats.get("chat-a");
    expect(row?.deleted).toBe(0);
    expect(row?.deletedAt).toBeUndefined();
    expect(await ChatRepository.getChat("chat-a")).toBeDefined();
    expect(indexed).toEqual(["chat-a"]);
    expect((await db.cache.get(CLAUDE_COUNT_KEY))?.value).toBe(5);

    // Search leaves out the rows whose deleted flag is 1; a restored chat is not among them.
    const leftOut = await db.chats.where("deleted").equals(1).primaryKeys();
    expect(leftOut).not.toContain("chat-a");
  });

  it("leaves a chat whose grace period has run out deleted, and indexes nothing", async () => {
    const db = getDB();
    await db.chats.put(buildChat("chat-old"));
    await ChatService.deleteChatsWithCleanup(["chat-old"]);
    await db.chats.update("chat-old", { deletedAt: Date.now() - SOFT_DELETE_GRACE_MS - 1000 });

    expect(await ChatService.restoreChatsWithCleanup(["chat-old"])).toEqual([]);

    const row = await db.chats.get("chat-old");
    expect(row?.deleted).toBe(1);
    expect(typeof row?.deletedAt).toBe("number");
    expect(indexed).toEqual([]);
  });

  it("restores only the chats of a batch that are still inside the grace period", async () => {
    const db = getDB();
    await db.chats.put(buildChat("chat-fresh"));
    await db.chats.put(buildChat("chat-stale"));
    await ChatService.deleteChatsWithCleanup(["chat-fresh", "chat-stale"]);
    await db.chats.update("chat-stale", { deletedAt: Date.now() - SOFT_DELETE_GRACE_MS - 1000 });

    expect(await ChatService.restoreChatsWithCleanup(["chat-fresh", "chat-stale"])).toEqual([
      "chat-fresh",
    ]);

    expect((await db.chats.get("chat-fresh"))?.deleted).toBe(0);
    expect((await db.chats.get("chat-stale"))?.deleted).toBe(1);
    expect(indexed).toEqual(["chat-fresh"]);
  });

  it("leaves a chat that was never deleted alone", async () => {
    const db = getDB();
    await db.chats.put(buildChat("chat-live"));

    expect(await ChatService.restoreChatsWithCleanup(["chat-live"])).toEqual([]);

    expect((await db.chats.get("chat-live"))?.deleted).toBe(0);
    expect(indexed).toEqual([]);
  });
});
