import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ImportBatchItem,
  ImportBusyError,
  importChatBatch,
  INCREMENTAL_INDEX_MAX_CHATS,
} from "../src/background/import/importBatch";
import { acquireOperationLock, getActiveOperation } from "../src/background/state";
import type { Chat } from "../src/model/haevn_model";

const { getChat, startBulkSyncIndexing, finishBulkSyncIndexing, saveImportedChat } = vi.hoisted(
  () => ({
    getChat: vi.fn(),
    startBulkSyncIndexing: vi.fn(async () => {}),
    finishBulkSyncIndexing: vi.fn(async () => {}),
    saveImportedChat: vi.fn(async () => {}),
  }),
);

vi.mock("../src/services/syncService", () => ({
  SyncService: { getChat, startBulkSyncIndexing, finishBulkSyncIndexing },
}));
vi.mock("../src/services/importService", () => ({ ImportService: { saveImportedChat } }));
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

  it("releases the lock when bulk mode cannot start, and does not try to finish it", async () => {
    startBulkSyncIndexing.mockRejectedValue(new Error("search worker gone"));

    await expect(
      importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 1), { overwrite: true, index: true }),
    ).rejects.toThrow("search worker gone");

    expect(finishBulkSyncIndexing).not.toHaveBeenCalled();
    expect(saveImportedChat).not.toHaveBeenCalled();
    expect(await getActiveOperation()).toBe("idle");
  });

  it("releases the lock and reports the batch when the rebuild cannot be started", async () => {
    finishBulkSyncIndexing.mockRejectedValue(new Error("search worker gone"));

    const result = await importChatBatch(items(INCREMENTAL_INDEX_MAX_CHATS + 1), {
      overwrite: true,
      index: true,
    });

    expect(result.saved).toBe(INCREMENTAL_INDEX_MAX_CHATS + 1);
    expect(await getActiveOperation()).toBe("idle");
  });
});
