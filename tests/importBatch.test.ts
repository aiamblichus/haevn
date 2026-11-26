import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImportBatchItem,
  ImportBusyError,
  INCREMENTAL_INDEX_MAX_CHATS,
  importChatBatch,
} from "../src/background/import/importBatch";
import { acquireOperationLock, getActiveOperation } from "../src/background/state";
import type { Chat } from "../src/model/haevn_model";

const {
  getChat,
  startBulkSyncIndexing,
  finishBulkSyncIndexing,
  saveImportedChat,
  queueGenerationForImportedChats,
} = vi.hoisted(() => ({
  getChat: vi.fn(),
  startBulkSyncIndexing: vi.fn(async () => {}),
  finishBulkSyncIndexing: vi.fn(async () => {}),
  saveImportedChat: vi.fn(async () => {}),
  queueGenerationForImportedChats: vi.fn(async (_chatIds: string[]) => {}),
}));

vi.mock("../src/services/syncService", () => ({
  SyncService: { getChat, startBulkSyncIndexing, finishBulkSyncIndexing },
}));
vi.mock("../src/services/importService", () => ({ ImportService: { saveImportedChat } }));
vi.mock("../src/services/metadataService", () => ({ queueGenerationForImportedChats }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

/** Every call the batch makes, in order, so that the order is part of what a test asserts. */
let calls: string[];

function items(count: number): ImportBatchItem[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `f${i}.jsonl`,
    load: async () => ({ chat: { id: `c${i}` } as Chat, raw: undefined }),
  }));
}

beforeEach(() => {
  calls = [];
  getChat.mockReset();
  getChat.mockResolvedValue(undefined);
  startBulkSyncIndexing.mockReset();
  startBulkSyncIndexing.mockImplementation(async () => {
    calls.push("startBulk");
  });
  finishBulkSyncIndexing.mockReset();
  finishBulkSyncIndexing.mockImplementation(async () => {
    calls.push("finishBulk");
  });
  saveImportedChat.mockReset();
  saveImportedChat.mockImplementation(async (chat: Chat, _raw: unknown, opts: unknown) => {
    calls.push(`save ${chat.id} ${JSON.stringify(opts)}`);
  });
  queueGenerationForImportedChats.mockReset();
});

describe("importing a batch of chats (HVN-38)", () => {
  it("fails with the running operation's name and saves nothing when the lock is taken", async () => {
    await acquireOperationLock("bulkSync");

    await expect(importChatBatch(items(3), { overwrite: true, index: true })).rejects.toThrow(
      ImportBusyError,
    );
    await expect(importChatBatch(items(3), { overwrite: true, index: true })).rejects.toThrow(
      /Another operation is running \(bulkSync\)/,
    );

    expect(saveImportedChat).not.toHaveBeenCalled();
    expect(startBulkSyncIndexing).not.toHaveBeenCalled();
    // It does not release a lock it never held.
    expect(await getActiveOperation()).toBe("bulkSync");
  });

  it("holds the lock while it saves and releases it after", async () => {
    const during: string[] = [];
    saveImportedChat.mockImplementation(async () => {
      during.push(await getActiveOperation());
    });

    await importChatBatch(items(2), { overwrite: true, index: true });

    expect(during).toEqual(["import", "import"]);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("indexes a small batch chat by chat, with no bulk mode and no rebuild", async () => {
    const result = await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS), {
      overwrite: true,
      index: true,
    });

    expect(result).toEqual({
      processed: INCREMENTAL_INDEX_MAX_CHATS,
      saved: INCREMENTAL_INDEX_MAX_CHATS,
      skipped: 0,
      errors: 0,
    });
    expect(startBulkSyncIndexing).not.toHaveBeenCalled();
    expect(finishBulkSyncIndexing).not.toHaveBeenCalled();
    expect(calls).toHaveLength(INCREMENTAL_INDEX_MAX_CHATS);
    expect(calls.every((c) => c.endsWith('{"skipIndexing":false}'))).toBe(true);
  });

  it("brackets a big batch with bulk mode and rebuilds once, after the last save", async () => {
    const count = INCREMENTAL_INDEX_MAX_CHATS + 1;

    const result = await importChatBatch(items(count), { overwrite: true, index: true });

    expect(result.saved).toBe(count);
    expect(calls[0]).toBe("startBulk");
    expect(calls[calls.length - 1]).toBe("finishBulk");
    expect(calls.filter((c) => c === "finishBulk")).toHaveLength(1);
    const saves = calls.slice(1, -1);
    expect(saves).toHaveLength(count);
    expect(saves.every((c) => c.endsWith('{"skipIndexing":true}'))).toBe(true);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("does not index at all when asked not to, whatever the size", async () => {
    await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 5), {
      overwrite: true,
      index: false,
    });

    expect(startBulkSyncIndexing).not.toHaveBeenCalled();
    expect(finishBulkSyncIndexing).not.toHaveBeenCalled();
    expect(calls.every((c) => c.endsWith('{"skipIndexing":true}'))).toBe(true);
  });

  it("counts a chat that fails to load or save as an error and goes on", async () => {
    const batch = items(3);
    batch[0].load = async () => {
      throw new Error("not a session file");
    };
    saveImportedChat.mockImplementation(async (chat: Chat) => {
      if (chat.id === "c1") throw new Error("disk full");
    });

    const result = await importChatBatch(batch, { overwrite: true, index: true });

    expect(result).toEqual({ processed: 3, saved: 1, skipped: 0, errors: 2 });
  });

  it("counts a chat without an id as an error", async () => {
    const batch: ImportBatchItem[] = [{ name: "x", load: async () => ({ chat: {} as Chat }) }];

    const result = await importChatBatch(batch, { overwrite: true, index: true });

    expect(result).toMatchObject({ saved: 0, errors: 1 });
    expect(saveImportedChat).not.toHaveBeenCalled();
  });

  it("skips chats already in the archive when overwrite is off", async () => {
    getChat.mockImplementation(async (id: string) => (id === "c1" ? { id } : undefined));

    const result = await importChatBatch(items(3), { overwrite: false, index: true });

    expect(result).toEqual({ processed: 3, saved: 2, skipped: 1, errors: 0 });
    expect(saveImportedChat).toHaveBeenCalledTimes(2);
  });

  it("still ends bulk mode and releases the lock when every chat fails", async () => {
    getChat.mockRejectedValue(new Error("db closed"));

    const result = await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 1), {
      overwrite: false,
      index: true,
    });

    expect(result.errors).toBe(INCREMENTAL_INDEX_MAX_CHATS + 1);
    expect(finishBulkSyncIndexing).toHaveBeenCalledTimes(1);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("reports an index error and still saves, ends bulk mode and frees the lock when bulk mode cannot start", async () => {
    startBulkSyncIndexing.mockRejectedValue(new Error("search worker gone"));
    const count = INCREMENTAL_INDEX_MAX_CHATS + 1;

    const result = await importChatBatch(items(count), { overwrite: true, index: true });

    expect(result).toMatchObject({ saved: count, errors: 0, indexError: "search worker gone" });
    // The worker may have switched to bulk mode before the call failed: switch it back.
    expect(finishBulkSyncIndexing).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith("save")).every((c) => c.endsWith("true}"))).toBe(true);
    expect(await getActiveOperation()).toBe("idle");
  });

  it("reports an index error, with the chats saved, when the rebuild cannot be started", async () => {
    finishBulkSyncIndexing.mockRejectedValue(new Error("rebuild refused"));
    const count = INCREMENTAL_INDEX_MAX_CHATS + 1;

    const result = await importChatBatch(items(count), { overwrite: true, index: true });

    expect(result).toMatchObject({ saved: count, errors: 0, indexError: "rebuild refused" });
    expect(await getActiveOperation()).toBe("idle");
  });

  it("names the first index failure when both ends fail", async () => {
    startBulkSyncIndexing.mockRejectedValue(new Error("first"));
    finishBulkSyncIndexing.mockRejectedValue(new Error("second"));

    const result = await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 1), {
      overwrite: true,
      index: true,
    });

    expect(result.indexError).toBe("first");
  });

  it("has no indexError when the index is brought up to date", async () => {
    const small = await importChatBatch(items(2), { overwrite: true, index: true });
    const big = await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 1), {
      overwrite: true,
      index: true,
    });

    expect(small).not.toHaveProperty("indexError");
    expect(big).not.toHaveProperty("indexError");
  });

  it("queues the chats it saved for AI metadata once, after the last save (HVN-53)", async () => {
    getChat.mockImplementation(async (id: string) => (id === "c1" ? { id } : undefined));
    queueGenerationForImportedChats.mockImplementation(async (chatIds: string[]) => {
      calls.push(`queue ${chatIds.join(",")}`);
    });
    saveImportedChat.mockImplementation(async (chat: Chat) => {
      calls.push(`save ${chat.id}`);
      if (chat.id === "c2") throw new Error("disk full");
    });

    await importChatBatch(items(4), { overwrite: false, index: true });

    // c1 was skipped (already there) and c2 failed: neither is queued.
    expect(calls).toEqual(["save c0", "save c2", "save c3", "queue c0,c3"]);
    expect(queueGenerationForImportedChats).toHaveBeenCalledTimes(1);
  });

  it("runs afterSave under the lock, with the saved ids, after the last save and before the queue (HVN-163)", async () => {
    queueGenerationForImportedChats.mockImplementation(async (chatIds: string[]) => {
      calls.push(`queue ${chatIds.join(",")}`);
    });
    saveImportedChat.mockImplementation(async (chat: Chat) => {
      calls.push(`save ${chat.id}`);
      if (chat.id === "c1") throw new Error("disk full");
    });
    const held: string[] = [];

    await importChatBatch(items(3), {
      overwrite: true,
      index: true,
      afterSave: async (savedIds) => {
        held.push(await getActiveOperation());
        calls.push(`after ${savedIds.join(",")}`);
      },
    });

    expect(held).toEqual(["import"]);
    expect(calls).toEqual(["save c0", "save c1", "save c2", "after c0,c2", "queue c0,c2"]);
  });

  it("goes on, and frees the lock, when afterSave throws", async () => {
    const result = await importChatBatch(items(2), {
      overwrite: true,
      index: true,
      afterSave: async () => {
        throw new Error("no metadata");
      },
    });

    expect(result).toMatchObject({ saved: 2, errors: 0 });
    expect(queueGenerationForImportedChats).toHaveBeenCalledWith(["c0", "c1"]);
    expect(await getActiveOperation()).toBe("idle");
  });
});
