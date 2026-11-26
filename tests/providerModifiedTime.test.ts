// HVN-165: a chat without `providerLastModifiedTimestamp` is left out of the
// `[deleted+providerLastModifiedTimestamp]` index, so it vanished from the archive under the
// "Modified Time" sort and from that sort's count. Every save now writes the field (falling back to
// `timestamp`), and a one-time pass writes it for the rows already stored.
import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { saveChat, saveChatToDb } from "../src/services/chatPersistence";
import { ChatRepository } from "../src/services/chatRepository";
import { getDB } from "../src/services/db";
import {
  PROVIDER_MODIFIED_BACKFILL_FLAG,
  runProviderModifiedBackfill,
} from "../src/services/providerModifiedBackfill";
import { getStorageAdapter } from "../src/storage";

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const CREATED = 1_700_000_000_000;

/** A chat as the CLI's media import and a Markdown import without `modified_at` write it. */
function buildChat(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    source: "unknown",
    sourceId: id,
    title: `Chat ${id}`,
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: CREATED,
    lastSyncedTimestamp: CREATED + 1,
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
    ...extra,
  };
}

async function listed(sortBy: string): Promise<{ ids: (string | undefined)[]; total: number }> {
  const { metadata, total } = await ChatRepository.getChatsMetadata(0, 50, "all", sortBy, "desc");
  return { ids: metadata.map((m) => m.id), total };
}

describe("a chat saved without providerLastModifiedTimestamp (HVN-165)", () => {
  beforeEach(async () => {
    const db = getDB();
    await Promise.all([db.chats.clear(), db.chatMessages.clear(), db.thumbnails.clear()]);
  });

  it("is listed and counted under every sort, Modified Time included", async () => {
    await saveChat(buildChat("bare"), undefined);
    await saveChat(buildChat("dated", { providerLastModifiedTimestamp: CREATED + 500 }), undefined);

    for (const sortBy of ["lastSyncedTimestamp", "title", "providerLastModifiedTimestamp"]) {
      const { ids, total } = await listed(sortBy);
      expect(total, sortBy).toBe(2);
      expect([...ids].sort(), sortBy).toEqual(["bare", "dated"]);
    }
  });

  it("takes the chat's own timestamp, and keeps a value the provider gave", async () => {
    await saveChat(buildChat("bare"), undefined);
    await saveChat(buildChat("dated", { providerLastModifiedTimestamp: CREATED + 500 }), undefined);

    expect((await getDB().chats.get("bare"))?.providerLastModifiedTimestamp).toBe(CREATED);
    expect((await getDB().chats.get("dated"))?.providerLastModifiedTimestamp).toBe(CREATED + 500);
  });

  it("is also listed when it reaches the table by saveChatToDb alone (a backup restore)", async () => {
    await saveChatToDb(buildChat("restored"));

    const { ids, total } = await listed("providerLastModifiedTimestamp");
    expect(total).toBe(1);
    expect(ids).toEqual(["restored"]);
  });
});

describe("the backfill of rows stored before the fix (HVN-165)", () => {
  beforeEach(async () => {
    const db = getDB();
    await Promise.all([db.chats.clear(), db.chatMessages.clear()]);
  });

  it("gives each row without the field its timestamp, soft-deleted ones too, and sets its flag", async () => {
    const db = getDB();
    // `put` straight to the table: these are the rows an older build wrote.
    await db.chats.bulkPut([
      buildChat("old-a"),
      buildChat("old-b", { timestamp: CREATED + 10 }),
      buildChat("old-deleted", { deleted: 1, deletedAt: CREATED }),
      buildChat("dated", { providerLastModifiedTimestamp: CREATED + 500 }),
    ]);
    expect((await listed("providerLastModifiedTimestamp")).total).toBe(1);

    const report = await runProviderModifiedBackfill();

    expect(report).toEqual({ status: "done", updated: 3 });
    expect((await listed("providerLastModifiedTimestamp")).total).toBe(3);
    expect((await db.chats.get("old-a"))?.providerLastModifiedTimestamp).toBe(CREATED);
    expect((await db.chats.get("old-b"))?.providerLastModifiedTimestamp).toBe(CREATED + 10);
    expect((await db.chats.get("old-deleted"))?.providerLastModifiedTimestamp).toBe(CREATED);
    expect((await db.chats.get("dated"))?.providerLastModifiedTimestamp).toBe(CREATED + 500);
    expect(await getStorageAdapter().get(PROVIDER_MODIFIED_BACKFILL_FLAG)).toBe("done");
  });

  it("reads only its flag once it has run", async () => {
    await runProviderModifiedBackfill();
    await getDB().chats.put(buildChat("late"));

    const report = await runProviderModifiedBackfill();

    expect(report).toEqual({ status: "already-done", updated: 0 });
    expect((await getDB().chats.get("late"))?.providerLastModifiedTimestamp).toBeUndefined();
  });
});
