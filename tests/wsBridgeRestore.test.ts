import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HVN-136: the four restore actions as the daemon forwards them. The session and the writes below
// the bridge are real (Dexie on fake-indexeddb, the operation lock, OPFS in memory); the daemon is
// a fake socket and a stubbed `fetch` that serves the CLI's upload on `GET /pipe/<id>`.

const getCliSettings = vi.hoisted(() => vi.fn());
const addOrUpdateChatInIndex = vi.hoisted(() => vi.fn(async (_id: string) => {}));
const rebuildIndex = vi.hoisted(() => vi.fn(async () => {}));
const recalculateProviderStats = vi.hoisted(() => vi.fn(async (_p: string) => 0));

vi.mock("../src/services/settingsService", () => ({
  getCliSettings,
  getMetadataAIConfig: vi.fn(),
  getStarmapConfig: vi.fn(),
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: { addOrUpdateChatInIndex, rebuildIndex },
}));
vi.mock("../src/services/cacheService", () => ({ CacheService: { recalculateProviderStats } }));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => {}),
}));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { FakeOpfs } from "./helpers/fakeOpfs";

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

async function connectedBridge(): Promise<{
  ask: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  vi.resetModules();
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

const PIPE = "0123456789abcdef0123456789abcdef";

let fs: FakeOpfs;
/** What each pipe id serves, and every request the extension made to the daemon. */
let pipes: Map<string, Uint8Array>;
let requests: Array<{ url: string; method: string; authorization: string | null }>;

function stubPipeFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      const id = url.split("/pipe/")[1];
      const body = pipes.get(id);
      if (!body || init?.method !== "GET") return new Response("no such pipe", { status: 404 });
      pipes.delete(id); // a pipe id works once
      return new Response(body, { status: 200, headers: { "Content-Length": `${body.length}` } });
    }),
  );
}

function chatRecord(chatId: string): Uint8Array {
  const chat = {
    id: chatId,
    source: "claude",
    sourceId: `s-${chatId}`,
    title: "Backed up",
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1,
    lastSyncedTimestamp: 1_000,
    checksum: "sum",
    syncStatus: "synced",
    deleted: 0,
  };
  const message = { id: "m1", childrenIds: [], message: [], model: "m", done: true, chatId };
  return new TextEncoder().encode(
    `${JSON.stringify({ v: 1, chat, metadata: null, embedding: null })}\n${JSON.stringify(message)}\n`,
  );
}

beforeEach(async () => {
  FakeWebSocket.instances = [];
  pipes = new Map();
  requests = [];
  fs = new FakeOpfs();
  fs.install();
  getCliSettings.mockReset();
  getCliSettings.mockResolvedValue({ enabled: true, port: 5517, apiKey: "secret-key" });
  addOrUpdateChatInIndex.mockClear();
  rebuildIndex.mockClear();
  recalculateProviderStats.mockClear();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true) },
    storage: {
      session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    },
  });
  stubPipeFetch();
  const { getDB } = await import("../src/services/db");
  await Promise.all(getDB().tables.map((table) => table.clear()));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restore over the bridge", () => {
  it("begins, takes a media file and a chat from the pipe with the key, and finishes", async () => {
    const { getDB } = await import("../src/services/db");
    const bridge = await connectedBridge();
    pipes.set(PIPE, new TextEncoder().encode("png!"));
    pipes.set("fedcba9876543210fedcba9876543210", chatRecord("c1"));

    const begin = await bridge.ask({ action: "restoreBegin", chats: 1 });
    const media = await bridge.ask({
      action: "restoreMedia",
      chatId: "c1",
      name: "m1_0.png",
      bytes: 4,
      pipeId: PIPE,
    });
    const chat = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: "fedcba9876543210fedcba9876543210",
      index: true,
    });
    const finish = await bridge.ask({ action: "restoreFinish", rebuildIndex: false });

    expect(begin).toMatchObject({ success: true, data: { indexPerChat: true } });
    expect(media).toMatchObject({ success: true, data: { bytes: 4 } });
    expect(chat).toMatchObject({ success: true, data: { replaced: false } });
    expect(finish).toMatchObject({ success: true });
    expect(fs.text("media/c1/m1_0.png")).toBe("png!");
    expect((await getDB().chats.get("c1"))?.title).toBe("Backed up");
    expect(addOrUpdateChatInIndex).toHaveBeenCalledWith("c1");
    // Both reads were GETs of the daemon's pipe, with the CLI's key
    expect(requests).toEqual([
      {
        url: `http://127.0.0.1:5517/pipe/${PIPE}`,
        method: "GET",
        authorization: "Bearer secret-key",
      },
      {
        url: "http://127.0.0.1:5517/pipe/fedcba9876543210fedcba9876543210",
        method: "GET",
        authorization: "Bearer secret-key",
      },
    ]);
  });

  it("starts one index rebuild at the end only when the finish asks for it", async () => {
    const bridge = await connectedBridge();
    await bridge.ask({ action: "restoreBegin", chats: 1 });
    await bridge.ask({ action: "restoreFinish", rebuildIndex: false });
    expect(rebuildIndex).not.toHaveBeenCalled();

    await bridge.ask({ action: "restoreBegin", chats: 1 });
    await bridge.ask({ action: "restoreFinish", rebuildIndex: true });
    expect(rebuildIndex).toHaveBeenCalledTimes(1);
  });

  it("refuses a chat without a session, with its code, and never asks the daemon for the pipe", async () => {
    const { getDB } = await import("../src/services/db");
    const bridge = await connectedBridge();
    pipes.set(PIPE, chatRecord("c1"));

    const reply = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: PIPE,
      index: false,
    });

    expect(reply).toMatchObject({ success: false, code: "NO_SESSION" });
    expect(requests).toEqual([]);
    expect(await getDB().chats.count()).toBe(0);
  });

  it("answers BUSY to restoreBegin while another operation holds the lock", async () => {
    const bridge = await connectedBridge();
    const { acquireOperationLock } = await import("../src/background/state");
    await acquireOperationLock("bulkSync");

    const reply = await bridge.ask({ action: "restoreBegin", chats: 1 });

    expect(reply).toMatchObject({ success: false, code: "BUSY" });
    expect(String(reply.error)).toContain("bulkSync");
  });

  it.each([
    ["a pipe id with a slash", "../../health"],
    ["an empty pipe id", ""],
    ["a pipe id with a query", "abc?x=1"],
  ])("refuses %s before it makes a request", async (_label, pipeId) => {
    const bridge = await connectedBridge();
    await bridge.ask({ action: "restoreBegin", chats: 1 });

    const reply = await bridge.ask({ action: "restoreChat", chatId: "c1", pipeId, index: false });

    expect(reply).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect(requests).toEqual([]);
  });

  it("refuses a media name with .. and writes nothing", async () => {
    const bridge = await connectedBridge();
    pipes.set(PIPE, new TextEncoder().encode("evil"));
    await bridge.ask({ action: "restoreBegin", chats: 1 });

    const reply = await bridge.ask({
      action: "restoreMedia",
      chatId: "c1",
      name: "..",
      bytes: 4,
      pipeId: PIPE,
    });

    expect(reply).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect(fs.files()).toEqual([]);
  });

  it("refuses a record for another chat with BAD_REQUEST, and the session stays usable", async () => {
    const { getDB } = await import("../src/services/db");
    const bridge = await connectedBridge();
    pipes.set(PIPE, chatRecord("someone-else"));
    pipes.set("fedcba9876543210fedcba9876543210", chatRecord("c1"));
    await bridge.ask({ action: "restoreBegin", chats: 2 });

    const refused = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: PIPE,
      index: false,
    });
    const accepted = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: "fedcba9876543210fedcba9876543210",
      index: false,
    });

    expect(refused).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect(accepted).toMatchObject({ success: true });
    expect((await getDB().chats.toArray()).map((c) => c.id)).toEqual(["c1"]);
  });

  it("answers PIPE_FAILED when the daemon refuses the pipe", async () => {
    const bridge = await connectedBridge();
    await bridge.ask({ action: "restoreBegin", chats: 1 });

    const reply = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      index: false,
    });

    expect(reply).toMatchObject({ success: false, code: "PIPE_FAILED" });
    expect(String(reply.error)).toContain("404");
  });

  it("answers PIPE_FAILED when the daemon cannot be reached", async () => {
    const bridge = await connectedBridge();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await bridge.ask({ action: "restoreBegin", chats: 1 });

    const reply = await bridge.ask({
      action: "restoreChat",
      chatId: "c1",
      pipeId: PIPE,
      index: false,
    });

    expect(reply).toMatchObject({ success: false, code: "PIPE_FAILED" });
  });
});
