// The move of messages from chat rows into the chatMessages table (HVN-31): the pass at service
// worker start, its flag and batches, what a failed chat does, and what a moved chat reads as.
// The search worker runs for real, so "searchable" is what the index itself answers.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import { saveChatToDb } from "../src/services/chatPersistence";
import { getDB } from "../src/services/db";
import { MESSAGE_MIGRATION_FLAG, runMessageMigration } from "../src/services/messageMigration";
import * as MetadataService from "../src/services/metadataService";
import { resetMemorySqliteHost } from "../src/services/searchIndex";
import { getStorageAdapter } from "../src/storage";
import { log } from "../src/utils/logger";

const toWorker = vi.hoisted(() => ({
  send: undefined as undefined | ((message: unknown) => Promise<void>),
}));
const getMetadataAIConfig = vi.hoisted(() => vi.fn());
const getStarmapConfig = vi.hoisted(() => vi.fn());

// SyncService reaches the search worker through the offscreen document; here it reaches the worker
// module loaded below, so a re-index is the message the manager really sends.
vi.mock("../src/utils/workerApi", () => ({
  sendWorkerRequest: async (_worker: string, message: unknown) => {
    await toWorker.send?.(message);
    return undefined;
  },
}));
vi.mock("../src/background/utils/offscreenUtils", () => ({
  ensureOffscreenDocument: async () => undefined,
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig,
  getStarmapConfig,
}));

// The worker talks through `self`: stand one in, import the module (which installs
// `self.onmessage`), and drive it with the messages the offscreen document would send.
type Posted = { type: string; requestId?: string; [key: string]: unknown };
let posted: Posted[] = [];

async function loadWorker(): Promise<void> {
  vi.resetModules();
  posted = [];
  const workerSelf = {
    postMessage: (message: Posted) => posted.push(message),
    onmessage: undefined as undefined | ((event: { data: unknown }) => Promise<void>),
  };
  vi.stubGlobal("self", workerSelf);
  await import("../src/services/search.worker");
  toWorker.send = (message) => {
    if (!workerSelf.onmessage) throw new Error("the worker did not install onmessage");
    return workerSelf.onmessage({ data: message });
  };
}

let requestCounter = 0;

/** What the worker answers a search with, in order. */
async function searchChunks(query: string): Promise<Posted[]> {
  const requestId = `test-${++requestCounter}`;
  await toWorker.send?.({ type: "search", query, requestId, hydrate: false });
  return posted.filter((m) => m.type === "searchResultChunk" && m.requestId === requestId);
}

/** The chat ids the index finds for a word, once the index is not being rebuilt. */
async function search(query: string): Promise<string[]> {
  const ids: string[] = [];
  for (const chunk of await searchChunks(query)) {
    for (const r of chunk.results as Array<string | { chatId: string }>) {
      ids.push(typeof r === "string" ? r : r.chatId);
    }
  }
  return ids.sort();
}

async function waitUntilIndexReady(): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    const [chunk] = await searchChunks("pineapple");
    if (chunk?.indexRebuilding === undefined) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("the index never became ready");
}

/** A message the way the release before v17 kept it: inside its chat's row. */
function message(chatId: string, id: string, text: string): ChatMessage {
  return {
    id,
    chatId,
    childrenIds: [],
    model: "test-model",
    done: true,
    timestamp: 1704067200000,
    message: [
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: text, timestamp: "2024-01-01T00:00:00Z" }],
      },
      {
        kind: "response",
        parts: [{ part_kind: "text", content: `answer to ${text}` }],
        timestamp: "2024-01-01T00:00:01Z",
      },
    ],
  } as unknown as ChatMessage;
}

function chatRow(id: string, messages: Record<string, ChatMessage>): Chat {
  return {
    id,
    source: "test",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["test-model"],
    system: undefined,
    params: {},
    currentId: "",
    messages,
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    providerLastModifiedTimestamp: undefined,
    checksum: "",
    syncStatus: "synced",
    lastSyncAttemptMessage: undefined,
    deleted: 0,
  } as unknown as Chat;
}

/** A chat in the old layout: its messages inline, and no rows in the table. */
function legacyChat(id: string, texts: string[]): Chat {
  const messages = Object.fromEntries(
    texts.map((text, i) => {
      const m = message(id, `${id}-m${i}`, text);
      return [m.id, m];
    }),
  );
  return chatRow(id, messages);
}

async function putLegacy(...chats: Chat[]): Promise<void> {
  await getDB().chats.bulkPut(chats);
}

/** The ids, of those given, whose messages are in the table. */
async function movedIds(ids: string[]): Promise<string[]> {
  const moved: string[] = [];
  for (const id of ids) {
    if ((await getDB().chatMessages.where("chatId").equals(id).count()) > 0) moved.push(id);
  }
  return moved;
}

/** The ids of a chat's messages in the table, in key order. */
async function tableIds(chatId: string): Promise<string[]> {
  return (await getDB().chatMessages.where("chatId").equals(chatId).toArray()).map((m) => m.id);
}

const flag = () => getStorageAdapter().get<string>(MESSAGE_MIGRATION_FLAG);

// Spies (the fetch the model is sent through, the alarms) are put back after each test.
afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  const db = getDB();
  await Promise.all([
    db.chats.clear(),
    db.chatMessages.clear(),
    db.metadataQueue.clear(),
    db.embeddingQueue.clear(),
    db.chatMetadata.clear(),
  ]);
  resetMemorySqliteHost();
  getMetadataAIConfig.mockReset();
  getStarmapConfig.mockReset();
  await loadWorker();
  // The index is open and empty before any old chat exists, so a chat is in it only if the
  // migration puts it there.
  await toWorker.send?.({ type: "init" });
  await waitUntilIndexReady();
});

describe("moving messages out of chat rows (HVN-31)", () => {
  it("moves an old chat's messages to the table, empties its row, and makes it searchable", async () => {
    await putLegacy(legacyChat("old", ["a pineapple on pizza"]));
    expect(await search("pineapple")).toEqual([]);

    const report = await runMessageMigration();

    // One pass moves the chat; a second finds nothing left, and only that pass sets the flag.
    expect(report).toMatchObject({ status: "done", passes: 2, migrated: 1, messages: 1 });
    expect(
      (await getDB().chatMessages.where("chatId").equals("old").toArray()).map((m) => m.id),
    ).toEqual(["old-m0"]);
    expect((await getDB().chats.get("old"))?.messages).toEqual({});
    expect(await search("pineapple")).toEqual(["old"]);
    expect(await flag()).toBe("done");
  });

  it("is a no-op the second time: the flag ends the pass before it reads a chat", async () => {
    await putLegacy(legacyChat("old", ["a pineapple on pizza"]));
    await runMessageMigration();

    const again = await runMessageMigration();

    expect(again).toMatchObject({ status: "already-done", scanned: 0, migrated: 0 });
    expect(await movedIds(["old"])).toEqual(["old"]);
  });

  it("a pass cut short after one batch leaves the flag unset, and the next start finishes it", async () => {
    await putLegacy(legacyChat("a", ["one"]), legacyChat("b", ["two"]), legacyChat("c", ["three"]));
    const controller = new AbortController();

    const cut = await runMessageMigration({
      batchSize: 1,
      signal: controller.signal,
      onBatch: () => controller.abort(),
    });

    expect(cut.status).toBe("stopped");
    expect(await flag()).toBeNull();
    expect(await movedIds(["a", "b", "c"])).toEqual(["a"]);

    const next = await runMessageMigration({ batchSize: 1 });

    expect(next.status).toBe("done");
    expect(await movedIds(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(await flag()).toBe("done");
  });

  it("a chat that fails is skipped and its row kept; the others move, the flag stays unset, and the next start retries it", async () => {
    await putLegacy(
      legacyChat("ok1", ["one"]),
      legacyChat("bad", ["two"]),
      legacyChat("ok2", ["three"]),
    );
    const table = getDB().chatMessages;
    const realBulkAdd = table.bulkAdd.bind(table);
    const failing = vi.spyOn(table, "bulkAdd").mockImplementation((async (
      rows: Array<{ chatId: string }>,
    ) => {
      if (rows.some((row) => row.chatId === "bad")) throw new Error("the disk is full");
      return realBulkAdd(rows as never);
    }) as never);

    const report = await runMessageMigration();
    failing.mockRestore();

    expect(report).toMatchObject({ status: "incomplete", failed: ["bad"] });
    expect(await movedIds(["ok1", "bad", "ok2"])).toEqual(["ok1", "ok2"]);
    expect(Object.keys((await getDB().chats.get("bad"))?.messages ?? {})).toEqual(["bad-m0"]);
    expect(await flag()).toBeNull();

    const next = await runMessageMigration();

    expect(next).toMatchObject({ status: "done", failed: [] });
    expect(await movedIds(["bad"])).toEqual(["bad"]);
    expect(await flag()).toBe("done");
  });

  it("an archive with nothing to move sets the flag in one pass", async () => {
    await getDB().chats.bulkPut([chatRow("a", {}), chatRow("b", {})]);

    const report = await runMessageMigration();

    expect(report).toMatchObject({ status: "done", scanned: 2, migrated: 0, passes: 1 });
    expect(await flag()).toBe("done");
  });
});

describe("a move that races a save or fails midway (HVN-31)", () => {
  it("does not write back the row its batch read, when a save lands before the move's transaction", async () => {
    await putLegacy(legacyChat("old", ["old one", "old two"]));
    const newer = chatRow("old", { "old-n": message("old", "old-n", "the newer message") });
    // The batch has read the old row. A save writes the chat before the move's transaction opens.
    const db = getDB();
    const transaction = db.transaction.bind(db) as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let saveLanded = false;
    vi.spyOn(db, "transaction").mockImplementation(((...args: unknown[]) => {
      if (saveLanded) return transaction(...args);
      saveLanded = true;
      return saveChatToDb(newer).then(() => transaction(...args));
    }) as never);

    const report = await runMessageMigration();

    expect(saveLanded).toBe(true);
    expect(report).toMatchObject({ status: "done", migrated: 0, failed: [] });
    expect(await tableIds("old")).toEqual(["old-n"]);
    expect(await getDB().chats.get("old")).toMatchObject({ messages: {} });
  });

  it("rolls the table back when the row cannot be updated, and the row keeps its messages", async () => {
    // The table holds nothing for the chat, so the move writes its messages there before the row.
    await putLegacy(legacyChat("old", ["old one", "old two"]));
    vi.spyOn(getDB().chats, "update").mockRejectedValueOnce(new Error("the row would not update"));

    const report = await runMessageMigration();

    expect(report).toMatchObject({ status: "incomplete", failed: ["old"], migrated: 0 });
    expect(await tableIds("old")).toEqual([]);
    expect(Object.keys((await getDB().chats.get("old"))?.messages ?? {}).sort()).toEqual([
      "old-m0",
      "old-m1",
    ]);
    expect(await flag()).toBeNull();
  });
});

describe("a move that finds the chat's messages already in the table (HVN-31)", () => {
  it("adds the row's messages the table lacks, keeps the table's copy of a shared one, and empties the row", async () => {
    // The row holds a and b. The table holds a newer b, and a c that only the table has.
    await putLegacy(legacyChat("old", ["a", "b"]));
    const newerB = { ...message("old", "old-m1", "b, saved again since"), chatId: "old" };
    await getDB().chatMessages.bulkPut([
      newerB,
      { ...message("old", "old-c", "c"), chatId: "old" },
    ]);
    vi.mocked(log.warn).mockClear();

    const report = await runMessageMigration();

    expect(report).toMatchObject({ status: "done", failed: [] });
    expect(await tableIds("old")).toEqual(["old-c", "old-m0", "old-m1"]);
    expect(await getDB().chatMessages.get(["old", "old-m1"])).toEqual(newerB);
    expect(await getDB().chats.get("old")).toMatchObject({ messages: {} });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 added from the row, 1 already in the table kept"),
    );
  });
});

describe("what the index reads of a chat (HVN-31)", () => {
  it("indexes the table's messages, and not the messages a row still carries inline", async () => {
    await putLegacy(legacyChat("old", ["a pineapple on pizza"]));
    const tart = { ...message("new", "new-m0", "a pineapple tart"), chatId: "new" };
    await getDB().chatMessages.bulkPut([tart]);
    await getDB().chats.put(chatRow("new", {}));

    await toWorker.send?.({ type: "rebuild" });

    expect(await search("pineapple")).toEqual(["new"]);
  });
});

describe("the metadata excerpt of a migrated chat (HVN-31)", () => {
  it("carries the chat's messages, which generateForChat reads from the table", async () => {
    getMetadataAIConfig.mockResolvedValue({
      enabled: true,
      url: "http://llm.test",
      apiKey: "",
      model: "m",
      categories: [{ name: "travel", description: "trips" }],
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 500, text: async () => "stopped here" } as Response);
    await putLegacy(legacyChat("old", ["the pineapple recipe"]));
    await runMessageMigration();

    await expect(MetadataService.generateForChat("old")).rejects.toThrow("LLM API error 500");

    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain("the pineapple recipe");
  });
});

describe("the metadata queue holds a chat until its messages have moved (HVN-31)", () => {
  const refused = () =>
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue({ ok: false, status: 500, text: async () => "stopped here" } as Response);

  beforeEach(() => {
    getMetadataAIConfig.mockResolvedValue({
      enabled: true,
      url: "http://llm.test",
      apiKey: "",
      model: "m",
      categories: [{ name: "travel", description: "trips" }],
    });
  });

  it("an old-layout chat stays pending, and the tick goes on to a moved chat behind it", async () => {
    const fetchSpy = refused();
    await putLegacy(legacyChat("old", ["the held recipe"]));
    const moved = { ...message("new", "new-m0", "the moved recipe"), chatId: "new" };
    await getDB().chatMessages.bulkPut([moved]);
    await getDB().chats.put(chatRow("new", {}));
    await getDB().metadataQueue.bulkPut([
      { chatId: "old", status: "pending", retries: 0, addedAt: 1 },
      { chatId: "new", status: "pending", retries: 0, addedAt: 2 },
    ]);

    await MetadataService.processQueueTick();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain("the moved recipe");
    expect(await getDB().metadataQueue.get("old")).toMatchObject({ status: "pending", retries: 0 });
  });

  it("a tick with only held chats sends nothing, and looks again at the queue period", async () => {
    const fetchSpy = refused();
    const alarm = vi.spyOn(chrome.alarms, "create");
    await putLegacy(legacyChat("old", ["the held recipe"]));
    await getDB().metadataQueue.put({ chatId: "old", status: "pending", retries: 0, addedAt: 1 });

    await MetadataService.processQueueTick();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getDB().metadataQueue.get("old")).toMatchObject({ status: "pending", retries: 0 });
    expect(alarm).toHaveBeenCalledWith(
      MetadataService.METADATA_PROCESS_ALARM,
      expect.objectContaining({ delayInMinutes: 5 }),
    );
  });

  it("generateOnRequest answers with the move message for an old-layout chat, and writes nothing", async () => {
    const fetchSpy = refused();
    await putLegacy(legacyChat("old", ["the held recipe"]));
    await getDB().metadataQueue.put({ chatId: "old", status: "pending", retries: 0, addedAt: 1 });

    await expect(MetadataService.generateOnRequest("old")).rejects.toThrow(
      "have not moved to the new storage layout yet. They move when the extension starts",
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getDB().chatMetadata.get("old")).toBeUndefined();
    expect(await getDB().metadataQueue.get("old")).toMatchObject({ status: "pending", retries: 0 });
  });

  it("after the move, the tick and the request both generate from the messages", async () => {
    const fetchSpy = refused();
    await putLegacy(legacyChat("old", ["the moved recipe"]));
    await getDB().metadataQueue.put({ chatId: "old", status: "pending", retries: 0, addedAt: 1 });
    await runMessageMigration();

    await MetadataService.processQueueTick();
    await expect(MetadataService.generateOnRequest("old")).rejects.toThrow("LLM API error 500");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    for (const call of fetchSpy.mock.calls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.messages[0].content).toContain("the moved recipe");
    }
  });
});
