import { beforeEach, describe, expect, it, vi } from "vitest";

// The bridge verbs that must do what the extension's own handlers do. Everything below the
// bridge is real (Dexie on fake-indexeddb, the metadata service); the daemon is a fake socket.

const getCliSettings = vi.hoisted(() => vi.fn());
const getMetadataAIConfig = vi.hoisted(() => vi.fn());
const getStarmapConfig = vi.hoisted(() => vi.fn());

vi.mock("../src/services/settingsService", () => ({
  getCliSettings,
  getMetadataAIConfig,
  getStarmapConfig,
}));
vi.mock("../src/services/syncService", () => ({ SyncService: {} }));
vi.mock("../src/services/importService", () => ({ ImportService: {} }));
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
      const { updatedAt: _updatedAt, chatId: _chatId, ...record } =
        (await getDB().chatMetadata.get(chatId)) ?? {};
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
