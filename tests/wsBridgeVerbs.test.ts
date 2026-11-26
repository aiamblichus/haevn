import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/services/loggerService";

// The bridge verbs that must do what the extension's own handlers do. Everything below the
// bridge is real (Dexie on fake-indexeddb, the metadata service); the daemon is a fake socket.

const getCliSettings = vi.hoisted(() => vi.fn());
const getMetadataAIConfig = vi.hoisted(() => vi.fn());
const getStarmapConfig = vi.hoisted(() => vi.fn());
const getChat = vi.hoisted(() => vi.fn());
const getChatsBySource = vi.hoisted(() => vi.fn());
const startBulkSyncIndexing = vi.hoisted(() => vi.fn());
const finishBulkSyncIndexing = vi.hoisted(() => vi.fn());
const saveImportedChat = vi.hoisted(() => vi.fn());
const getChatsMetadata = vi.hoisted(() => vi.fn());
const getChatMessages = vi.hoisted(() => vi.fn());
const unmovedRefusal = vi.hoisted(() => vi.fn());
const getPrimaryBranchMessages = vi.hoisted(() => vi.fn());
const getChatWithMessages = vi.hoisted(() => vi.fn());

vi.mock("../src/services/settingsService", () => ({
  getCliSettings,
  getMetadataAIConfig,
  getStarmapConfig,
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: {
    getChat,
    getChatsBySource,
    getChatsMetadata,
    getChatMessages,
    unmovedRefusal,
    getPrimaryBranchMessages,
    getChatWithMessages,
    startBulkSyncIndexing,
    finishBulkSyncIndexing,
  },
}));
vi.mock("../src/services/importService", () => ({ ImportService: { saveImportedChat } }));
vi.mock("../src/background/export/textExportArtifact", () => ({
  buildTextExportArtifact: vi.fn(),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/** A bridge that is connected to a fake daemon; `ask` sends one request and returns the reply. */
async function connectedBridge(): Promise<{
  ask: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  vi.resetModules();
  // A reset drops the storage adapter the test setup installed; the lock lives in it.
  const storage = await import("../src/storage");
  storage.setStorageAdapter(new storage.MemoryStorageAdapter());
  const bridge = await import("../src/background/wsBridge");
  await bridge.applyWsBridgeSettings();
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  socket.receive({ type: "authOk" });

  let next = 0;
  return {
    async ask(request) {
      const id = `r${++next}`;
      socket.receive({ id, ...request });
      await vi.waitFor(() => expect(socket.sent.some((f) => f.id === id)).toBe(true));
      return socket.sent.find((f) => f.id === id) as Record<string, unknown>;
    },
  };
}

beforeEach(async () => {
  FakeWebSocket.instances = [];
  getCliSettings.mockReset();
  getCliSettings.mockResolvedValue({ enabled: true, port: 5517, apiKey: "key" });
  getMetadataAIConfig.mockReset();
  getMetadataAIConfig.mockResolvedValue({ enabled: true });
  getStarmapConfig.mockReset();
  getStarmapConfig.mockResolvedValue({
    enabled: true,
    embeddingsEnabled: true,
    autoEmbedOnMetadataChange: true,
    embeddingUrl: "http://localhost:1234",
    embeddingModel: "m",
  });
  getChat.mockReset();
  getChat.mockResolvedValue(undefined);
  getChatsBySource.mockReset();
  getChatsBySource.mockResolvedValue([]);
  startBulkSyncIndexing.mockReset();
  finishBulkSyncIndexing.mockReset();
  saveImportedChat.mockReset();
  getChatsMetadata.mockReset();
  getChatsMetadata.mockResolvedValue({ metadata: [], total: 0 });
  getChatMessages.mockReset();
  getChatMessages.mockResolvedValue({});
  unmovedRefusal.mockReset();
  unmovedRefusal.mockResolvedValue(undefined);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true) },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  });

  const { getDB } = await import("../src/services/db");
  await Promise.all([
    getDB().chatMetadata.clear(),
    getDB().metadataQueue.clear(),
    getDB().embeddingQueue.clear(),
  ]);
});

describe("setMetadata over the bridge does what the UI's handler does (HVN-30)", () => {
  it("writes the record as a manual one, dequeues AI generation and queues the embedding", async () => {
    const { getDB } = await import("../src/services/db");
    await getDB().metadataQueue.put({
      chatId: "c1",
      status: "pending",
      retries: 0,
      addedAt: 1,
    });
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "setMetadata",
      chatId: "c1",
      metadata: { title: "By hand", keywords: ["a"] },
    });

    expect(reply).toMatchObject({
      success: true,
      data: { chatId: "c1", title: "By hand", keywords: ["a"], source: "manual" },
    });
    // The AI would otherwise overwrite the person's words at the next queue tick.
    expect(await getDB().metadataQueue.get("c1")).toBeUndefined();
    expect(await getDB().embeddingQueue.get("c1")).toMatchObject({
      chatId: "c1",
      status: "pending",
    });
  });

  it("leaves the same stored state as the UI's setChatMetadata handler", async () => {
    const { getDB } = await import("../src/services/db");
    const { handleSetChatMetadata } = await import("../src/background/handlers/metadataHandlers");
    const bridge = await connectedBridge();
    const update = { title: "By hand", categories: ["x"] };

    async function stateAfter(write: (chatId: string) => Promise<void>) {
      const chatId = `c-${Math.random().toString(36).slice(2)}`;
      await getDB().metadataQueue.put({ chatId, status: "pending", retries: 0, addedAt: 1 });
      await write(chatId);
      const {
        updatedAt: _updatedAt,
        chatId: _chatId,
        ...record
      } = (await getDB().chatMetadata.get(chatId)) ?? {};
      return {
        record,
        queued: await getDB().metadataQueue.get(chatId),
        embedding: (await getDB().embeddingQueue.get(chatId))?.status,
      };
    }

    const viaHandler = await stateAfter(async (chatId) => {
      const sendResponse = vi.fn();
      await handleSetChatMetadata(
        { action: "setChatMetadata", chatId, metadata: update },
        sendResponse,
      );
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });
    const viaBridge = await stateAfter(async (chatId) => {
      await bridge.ask({ action: "setMetadata", chatId, metadata: update });
    });

    expect(viaBridge).toEqual(viaHandler);
    expect(viaBridge.embedding).toBe("pending");
  });
});

describe("generateMetadata over the bridge does what the UI's handler does (HVN-53)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    getMetadataAIConfig.mockResolvedValue({
      enabled: true,
      url: "http://llm.test/v1",
      apiKey: "",
      model: "m",
      categories: [],
    });
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                title: "Generated",
                description: "d",
                synopsis: "s",
                categories: ["Other"],
                keywords: ["k"],
              }),
            },
          },
        ],
      }),
    }));
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
  });

  async function chatInQueue(chatId: string) {
    const { getDB } = await import("../src/services/db");
    await getDB().chats.put({ id: chatId, title: chatId, source: "claude" } as never);
    await getDB().metadataQueue.put({ chatId, status: "pending", retries: 0, addedAt: 1 });
    return getDB();
  }

  it("takes the chat off the generation queue once it has generated its metadata", async () => {
    const db = await chatInQueue("c1");
    const bridge = await connectedBridge();

    const reply = await bridge.ask({ action: "generateMetadata", chatId: "c1" });

    expect(reply).toMatchObject({
      success: true,
      data: { chatId: "c1", title: "Generated", source: "ai" },
    });
    // Left there, the next queue tick would generate it a second time.
    expect(await db.metadataQueue.get("c1")).toBeUndefined();
  });

  it("leaves the same stored state as the UI's generateChatMetadata handler", async () => {
    const { handleGenerateChatMetadata } = await import(
      "../src/background/handlers/metadataHandlers"
    );
    const bridge = await connectedBridge();

    async function stateAfter(generate: (chatId: string) => Promise<void>) {
      const chatId = `c-${Math.random().toString(36).slice(2)}`;
      const db = await chatInQueue(chatId);
      await generate(chatId);
      const {
        updatedAt: _u,
        generatedAt: _g,
        chatId: _c,
        ...record
      } = (await db.chatMetadata.get(chatId)) ?? {};
      return {
        record,
        queued: await db.metadataQueue.get(chatId),
        embedding: (await db.embeddingQueue.get(chatId))?.status,
      };
    }

    const viaHandler = await stateAfter(async (chatId) => {
      const sendResponse = vi.fn();
      await handleGenerateChatMetadata({ action: "generateChatMetadata", chatId }, sendResponse);
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });
    const viaBridge = await stateAfter(async (chatId) => {
      await bridge.ask({ action: "generateMetadata", chatId });
    });

    expect(viaBridge).toEqual(viaHandler);
    expect(viaBridge.queued).toBeUndefined();
  });
});

describe("import over the bridge goes through the archive's import sequence (HVN-38)", () => {
  // The batch's own rules (lock, bulk mode, counts) are in importBatch.test.ts; this is the wire.
  function files(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      name: `chat-${i}.json`,
      content: JSON.stringify({
        id: `chat-${i}`,
        sourceId: `src-${i}`,
        source: "claude",
        title: `Chat ${i}`,
        currentId: "m1",
        messages: { m1: { id: "m1" } },
      }),
    }));
  }

  it("keeps the CLI's response shape", async () => {
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(2),
      options: { overwrite: true },
    });

    expect(reply).toEqual({
      id: expect.any(String),
      success: true,
      data: { format: "haevn_json", total: 2, processed: 2, saved: 2, skipped: 0, errors: 0 },
    });
  });

  describe("a fragment import and its dry run (HVN-163)", () => {
    const fragment = {
      name: "note.md",
      content:
        "---\nid: 7b0e6c1e-2f4a-4c58-9d0b-3a1f5e8c9a12\n---\n## User\nHello\n\n## Assistant\nHi\n",
    };

    it("answers the plan and saves nothing when options.dryRun is set", async () => {
      const bridge = await connectedBridge();

      const reply = await bridge.ask({
        action: "import",
        format: "fragment",
        files: [fragment],
        options: { overwrite: true, dryRun: true },
      });

      expect(reply).toMatchObject({
        success: true,
        data: {
          format: "fragment",
          dryRun: true,
          saved: 0,
          plan: [{ name: "note.md", state: "new" }],
        },
      });
      expect(saveImportedChat).not.toHaveBeenCalled();
    });

    it("saves the fragment when it is not a dry run (the control of the test above)", async () => {
      const bridge = await connectedBridge();

      const reply = await bridge.ask({
        action: "import",
        format: "fragment",
        files: [fragment],
        options: { overwrite: true },
      });

      expect(reply).toMatchObject({
        success: true,
        data: { format: "fragment", dryRun: false, saved: 1, plan: [{ state: "new" }] },
      });
      expect(saveImportedChat).toHaveBeenCalledTimes(1);
    });

    it("refuses a dry run of any other format instead of importing", async () => {
      const bridge = await connectedBridge();

      const reply = await bridge.ask({
        action: "import",
        format: "haevn_json",
        files: files(1),
        options: { overwrite: true, dryRun: true },
      });

      expect(reply).toMatchObject({ success: false, code: "BAD_REQUEST" });
      expect(reply.error).toContain("only offered for the fragment format");
      expect(saveImportedChat).not.toHaveBeenCalled();
    });
  });

  it("imports one chat per room of an OpenRouter file, and counts the chats", async () => {
    const { makeExport, makeRoom } = await import("./helpers/openrouterExport");
    const room = (title: string, start: number) =>
      makeRoom({
        title,
        start,
        characters: { "char-a": "vendor/model-a" },
        turns: [{ user: "Hi", replies: [{ character: "char-a", text: "Hello" }] }],
      });
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "import",
      format: "openrouter",
      files: [
        {
          name: "rooms.json",
          content: JSON.stringify(
            makeExport([room("One", 1_800_000_000), room("Two", 1_800_100_000)]),
          ),
        },
        { name: "broken.json", content: "{nope" },
      ],
      options: { overwrite: true },
    });

    expect(reply).toEqual({
      id: expect.any(String),
      success: true,
      data: { format: "openrouter", total: 3, processed: 3, saved: 2, skipped: 0, errors: 1 },
    });
    expect(saveImportedChat.mock.calls.map(([chat]) => [chat.title, chat.source])).toEqual([
      ["One", "openrouter"],
      ["Two", "openrouter"],
    ]);
  });

  it("answers total 0 for an OpenRouter file whose chatrooms are all empty, saving nothing", async () => {
    const { makeExport } = await import("./helpers/openrouterExport");
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "import",
      format: "openrouter",
      files: [
        {
          name: "empty.json",
          content: JSON.stringify(makeExport([{ title: "Empty", messages: {}, items: {} }])),
        },
      ],
      options: { overwrite: true },
    });

    expect(reply).toMatchObject({
      success: true,
      data: { format: "openrouter", total: 0, processed: 0, saved: 0, errors: 0 },
    });
    expect(saveImportedChat).not.toHaveBeenCalled();
  });

  it("skipIndex saves without indexing now", async () => {
    const bridge = await connectedBridge();

    await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(1),
      options: { overwrite: true, skipIndex: true },
    });

    expect(saveImportedChat.mock.calls[0][2]).toEqual({ skipIndexing: true });
  });

  it("answers BUSY, with the running operation named, while another holds the lock", async () => {
    const bridge = await connectedBridge();
    const { acquireOperationLock } = await import("../src/background/state");
    await acquireOperationLock("bulkExport");

    const reply = await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(1),
      options: { overwrite: true },
    });

    expect(reply).toMatchObject({ success: false, code: "BUSY" });
    expect(reply.error).toContain("Another operation is running (bulkExport)");
    expect(saveImportedChat).not.toHaveBeenCalled();
  });

  it("carries an index failure in the response next to the counts", async () => {
    finishBulkSyncIndexing.mockRejectedValue(new Error("rebuild refused"));
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(25),
      options: { overwrite: true },
    });

    expect(reply).toMatchObject({
      success: true,
      data: { saved: 25, errors: 0, indexError: "rebuild refused" },
    });
  });

  it("queues the chats it saved for AI metadata when automatic generation is on (HVN-53)", async () => {
    getMetadataAIConfig.mockResolvedValue({ enabled: true, autoGenerate: true });
    const { getDB } = await import("../src/services/db");
    const bridge = await connectedBridge();

    await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(2),
      options: { overwrite: true },
    });

    const queued = await getDB().metadataQueue.toArray();
    expect(queued.map((q) => [q.chatId, q.status]).sort()).toEqual([
      ["chat-0", "pending"],
      ["chat-1", "pending"],
    ]);
  });

  it("queues nothing when automatic generation is off", async () => {
    getMetadataAIConfig.mockResolvedValue({ enabled: true, autoGenerate: false });
    const { getDB } = await import("../src/services/db");
    const bridge = await connectedBridge();

    await bridge.ask({
      action: "import",
      format: "haevn_json",
      files: files(2),
      options: { overwrite: true },
    });

    expect(await getDB().metadataQueue.count()).toBe(0);
  });
});

describe("get, branches and export refuse a chat whose messages have not moved (HVN-31)", () => {
  it.each([
    "get",
    "branches",
    "export",
  ])("%s answers with the refusal, and reads the chat for nothing", async (action) => {
    const refusal = "Chat old cannot be read yet: its messages have not moved.";
    unmovedRefusal.mockResolvedValue(refusal);
    const { ask } = await connectedBridge();

    const reply = await ask({ action, chatId: "old" });

    expect(reply).toMatchObject({ success: false, error: refusal });
    expect(unmovedRefusal).toHaveBeenCalledWith("old");
    expect(getChat).not.toHaveBeenCalled();
  });
});

describe("get and branches carry a rough date's label (HVN-171)", () => {
  // A fragment dated ~2024-03: its stored times are made up for ordering (HVN-163).
  const ROUGH = {
    text: "~2024-03",
    precision: "month",
    approximate: true,
    from: Date.UTC(2024, 2, 1),
    to: Date.UTC(2024, 3, 1),
  };
  const TIMESTAMP = Date.UTC(2024, 2, 16, 12);
  const chat = {
    id: "c-rough",
    source: "fragment",
    sourceId: "7b0e6c1e-2f4a-4c58-9d0b-3a1f5e8c9a12",
    title: "The lantern keeper",
    models: ["made-up-model"],
    params: { roughDate: ROUGH },
    currentId: "t0002",
    messages: {},
    tags: [],
    timestamp: TIMESTAMP,
    lastSyncedTimestamp: TIMESTAMP,
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
  };

  beforeEach(() => {
    getChat.mockResolvedValue(chat);
    getChatWithMessages.mockResolvedValue({ ...chat, messages: {} });
    getPrimaryBranchMessages.mockResolvedValue([]);
  });

  it("get gives the label, and keeps the stored times and params as they were", async () => {
    const { ask } = await connectedBridge();

    const reply = await ask({ action: "get", chatId: "c-rough", options: {} });

    expect(reply).toMatchObject({
      success: true,
      data: { dateLabel: "c. Mar 2024", timestamp: TIMESTAMP, params: { roughDate: ROUGH } },
    });
  });

  it("branches gives the label too", async () => {
    const { ask } = await connectedBridge();

    const reply = await ask({ action: "branches", chatId: "c-rough" });

    expect(reply).toMatchObject({
      success: true,
      data: { dateLabel: "c. Mar 2024", timestamp: TIMESTAMP },
    });
  });

  it("a chat without a rough date gets no dateLabel, so an older CLI sees nothing new", async () => {
    const plain = { ...chat, params: {} };
    getChat.mockResolvedValue(plain);
    getChatWithMessages.mockResolvedValue({ ...plain, messages: {} });
    const { ask } = await connectedBridge();

    const got = await ask({ action: "get", chatId: "c-rough", options: {} });
    const branches = await ask({ action: "branches", chatId: "c-rough" });

    expect(got.data).not.toHaveProperty("dateLabel");
    expect(branches.data).not.toHaveProperty("dateLabel");
  });
});

describe("list pages over the bridge (HVN-14)", () => {
  const DAY = Date.parse("2026-06-01T00:00:00Z");

  /** The repository's answer for one page: `rows` chats, out of `total` on the platform. */
  function repositoryPage(rows: number, total: number): void {
    getChatsMetadata.mockResolvedValue({
      metadata: Array.from({ length: rows }, (_, i) => ({
        id: `c${i}`,
        lastSyncedTimestamp: DAY - i * 1000,
      })),
      total,
    });
  }

  it("passes the offset, limit and sort through to the repository", async () => {
    repositoryPage(2, 9);
    const bridge = await connectedBridge();

    await bridge.ask({ action: "list", options: { limit: 2, offset: 4 } });

    expect(getChatsMetadata).toHaveBeenCalledWith(4, 2, "all", "lastSyncedTimestamp", "desc");
  });

  it("reports more chats while the page ends before the total", async () => {
    repositoryPage(2, 5);
    const bridge = await connectedBridge();

    const reply = await bridge.ask({ action: "list", options: { limit: 2, offset: 0 } });

    expect(reply).toMatchObject({ success: true, data: { total: 5, hasMore: true } });
  });

  it("reports no more on the last, short page", async () => {
    repositoryPage(1, 5);
    const bridge = await connectedBridge();

    const reply = await bridge.ask({ action: "list", options: { limit: 2, offset: 4 } });

    expect(reply).toMatchObject({ success: true, data: { total: 5, hasMore: false } });
  });

  it("reports no more when a page ends exactly at the total", async () => {
    repositoryPage(2, 4);
    const bridge = await connectedBridge();

    const reply = await bridge.ask({ action: "list", options: { limit: 2, offset: 2 } });

    expect(reply).toMatchObject({ success: true, data: { total: 4, hasMore: false } });
  });

  it("counts the page's rows, not the chats the after-date filter keeps", async () => {
    getChatsMetadata.mockResolvedValue({
      metadata: [
        { id: "c0", lastSyncedTimestamp: DAY },
        { id: "c1", lastSyncedTimestamp: Date.parse("2025-01-01T00:00:00Z") },
      ],
      total: 5,
    });
    const bridge = await connectedBridge();

    const reply = await bridge.ask({
      action: "list",
      options: { limit: 2, offset: 0, after: "2026-01-01" },
    });

    expect(reply).toMatchObject({
      success: true,
      data: { chats: [{ id: "c0" }], total: 5, hasMore: true },
    });
  });

  it("refuses an offset that is not a whole number, 0 or more", async () => {
    const bridge = await connectedBridge();

    for (const offset of [-1, 1.5]) {
      const reply = await bridge.ask({ action: "list", options: { limit: 2, offset } });
      expect(reply).toMatchObject({ success: false, code: "BAD_REQUEST" });
    }
    expect(getChatsMetadata).not.toHaveBeenCalled();
  });
});

describe("logs over the bridge answer the logger's own entries (HVN-156)", () => {
  /** An entry as the logger keeps it: `n` makes each one its own. */
  function entry(n: number): LogEntry {
    return {
      id: `e${n}`,
      timestamp: Date.parse("2026-06-01T00:00:00Z") + n,
      level: "INFO",
      message: `entry ${n}`,
      context: "background",
    };
  }

  it("passes the level, context and match to the logger, and no other filter", async () => {
    const bridge = await connectedBridge();
    // after the bridge is loaded: the same module instance the bridge holds
    const { loggerService } = await import("../src/services/loggerService");
    const getLogs = vi.spyOn(loggerService, "getLogs");

    await bridge.ask({
      action: "logs",
      options: { limit: 5, level: "WARN", context: "background", match: "sync" },
    });

    expect(getLogs).toHaveBeenCalledWith({ level: "WARN", context: "background", match: "sync" });
  });

  it("answers the newest `limit` entries, oldest first, and 200 when no limit is asked", async () => {
    const bridge = await connectedBridge();
    const { loggerService } = await import("../src/services/loggerService");
    for (let n = 1; n <= 3; n++) loggerService.addEntry(entry(n));

    const two = await bridge.ask({ action: "logs", options: { limit: 2 } });
    const all = await bridge.ask({ action: "logs" });

    expect(two).toMatchObject({ success: true });
    expect(two.data).toEqual([entry(2), entry(3)]);
    expect(all.data).toEqual([entry(1), entry(2), entry(3)]);
  });

  it("refuses a limit that is not a whole number from 1 to 1000, and a level it does not know", async () => {
    const bridge = await connectedBridge();
    const { loggerService } = await import("../src/services/loggerService");
    const getLogs = vi.spyOn(loggerService, "getLogs");

    for (const options of [{ limit: 0 }, { limit: 1.5 }, { limit: 1001 }, { level: "warn" }]) {
      const reply = await bridge.ask({ action: "logs", options });
      expect(reply).toMatchObject({ success: false, code: "BAD_REQUEST" });
    }
    expect(getLogs).not.toHaveBeenCalled();
  });
});
