// HVN-146: a single-chat sync (the popup's or the CLI's) takes no operation lock, and it writes a
// chat's media before its row. transformAndSaveChat counts it, and the Janitor yields to the count.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { singleSyncsInFlight } from "../src/background/state";
import { transformAndSaveChat } from "../src/background/utils/chatSyncUtils";
import { getDB } from "../src/services/db";
import { JanitorService } from "../src/services/janitorService";
import { getMediaStorageService } from "../src/services/mediaStorage";
import { SearchIndexManager } from "../src/services/searchIndexManager";
import type { AllProviderRawData } from "../src/types/messaging";

const transform = vi.hoisted(() => ({
  run: undefined as (() => Promise<never[]>) | undefined,
}));

vi.mock("../src/background/utils/platformTransform", () => ({
  transformRawDataToHaevn: () => (transform.run ?? (async () => []))(),
}));

const raw = {} as AllProviderRawData;

async function seedSoftDeletedChat(id: string): Promise<void> {
  await getDB().chats.put({
    id,
    source: "test",
    sourceId: id,
    title: id,
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1,
    files: [],
    lastSyncedTimestamp: 0,
    checksum: "",
    syncStatus: "synced",
    deleted: 1,
    deletedAt: Date.now() - 10 * 60_000,
  } as never);
}

describe("single-chat syncs and the Janitor", () => {
  let dirsDeleted: string[];

  beforeEach(async () => {
    await getDB().chats.clear();
    dirsDeleted = [];
    vi.spyOn(SearchIndexManager, "removeChatsFromIndexBulk").mockResolvedValue(undefined);
    vi.spyOn(getMediaStorageService(), "deleteChatDir").mockImplementation(async (id) => {
      dirsDeleted.push(id);
      return true;
    });
  });

  afterEach(() => {
    transform.run = undefined;
    vi.restoreAllMocks();
  });

  it("makes the Janitor wait while a sync is transforming, and lets it run when the sync ends", async () => {
    await seedSoftDeletedChat("gone");
    let fail: (error: Error) => void = () => {};
    transform.run = () =>
      new Promise<never[]>((_resolve, reject) => {
        fail = reject;
      });

    const sync = transformAndSaveChat(raw, "claude", "claude.ai");
    const outcome = sync.then(
      () => "saved",
      () => "failed",
    );
    expect(singleSyncsInFlight()).toBe(1);

    expect(await JanitorService.cleanupSoftDeletedChats(0)).toBe(0);
    expect(await getDB().chats.get("gone")).toMatchObject({ deleted: 1 });
    expect(dirsDeleted).toEqual([]);

    fail(new Error("the page went away"));
    expect(await outcome).toBe("failed");

    expect(await JanitorService.cleanupSoftDeletedChats(0)).toBe(1);
    expect(dirsDeleted).toEqual(["gone"]);
  });

  it("counts a sync that finishes and one that throws back to zero", async () => {
    expect(singleSyncsInFlight()).toBe(0);

    transform.run = async () => [];
    expect(await transformAndSaveChat(raw, "claude", "claude.ai")).toEqual([]);
    expect(singleSyncsInFlight()).toBe(0);

    transform.run = async () => {
      throw new Error("Unsupported platform for sync");
    };
    await expect(transformAndSaveChat(raw, "claude", "claude.ai")).rejects.toThrow(/Unsupported/);
    expect(singleSyncsInFlight()).toBe(0);
  });
});
