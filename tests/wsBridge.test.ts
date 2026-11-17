import { beforeEach, describe, expect, it, vi } from "vitest";

const searchChatsStreaming = vi.hoisted(() => vi.fn());
const getCliSettings = vi.hoisted(() => vi.fn());

vi.mock("../src/services/syncService", () => ({ SyncService: { searchChatsStreaming } }));
vi.mock("../src/services/settingsService", () => ({ getCliSettings }));
vi.mock("../src/services/importService", () => ({ ImportService: {} }));
vi.mock("../src/services/metadataRepository", () => ({
  getMany: vi.fn(async () => new Map()),
}));
vi.mock("../src/services/metadataService", () => ({ generateForChat: vi.fn() }));
vi.mock("../src/background/export/textExportArtifact", () => ({
  buildTextExportArtifact: vi.fn(),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// The bridge talks through a WebSocket and chrome.alarms; stand both in and drive them as the
// daemon and the browser would.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
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

  /** A close the extension asks for: its handlers are detached by then or do not matter. */
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** The daemon completes the handshake and accepts the key. */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    this.receive({ type: "authOk" });
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The daemon (or the network) closes the socket with `code`. */
  drop(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }
}

const alarms = { create: vi.fn(), clear: vi.fn(async () => true) };

type Bridge = typeof import("../src/background/wsBridge");

/** A fresh module (the bridge keeps its state at module level), as a service worker wakes up. */
async function loadBridge(): Promise<Bridge> {
  vi.resetModules();
  return import("../src/background/wsBridge");
}

function sockets(): FakeWebSocket[] {
  return FakeWebSocket.instances;
}

function latest(): FakeWebSocket {
  return sockets()[sockets().length - 1];
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  searchChatsStreaming.mockReset();
  alarms.create.mockClear();
  alarms.clear.mockClear();
  getCliSettings.mockReset();
  getCliSettings.mockResolvedValue({ enabled: true, port: 5517, apiKey: "key" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", { alarms });
});

describe("the bridge answering a search after a failed index rebuild (HVN-50)", () => {
  async function connectedBridge(): Promise<FakeWebSocket> {
    const bridge = await loadBridge();
    await bridge.applyWsBridgeSettings();
    const socket = latest();
    socket.accept();
    return socket;
  }

  async function answerFor(
    stats: Record<string, unknown>,
    collected: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    searchChatsStreaming.mockImplementation(
      (
        _query: string,
        options: { onResults: (b: unknown[]) => void; onComplete: (s: unknown) => void },
      ) => {
        options.onResults(collected);
        options.onComplete({ totalResults: collected.length, ...stats });
        return { cancel: () => {} };
      },
    );
    const socket = await connectedBridge();
    socket.receive({ id: "r1", action: "search", query: "pineapple" });
    await vi.waitFor(() => expect(socket.sent.some((f) => f.id === "r1")).toBe(true));
    return socket.sent.find((f) => f.id === "r1") as Record<string, unknown>;
  }

  it("fails with INDEX_INCOMPLETE and the reason, also when it found something", async () => {
    const reply = await answerFor({ indexIncomplete: { error: "boom" } }, [
      { chatId: "c1", messageId: "m1" },
    ]);

    expect(reply).toMatchObject({ id: "r1", success: false, code: "INDEX_INCOMPLETE" });
    expect(reply.error).toContain("boom");
  });

  it("still answers INDEX_REBUILDING while a rebuild runs", async () => {
    const reply = await answerFor({
      indexRebuilding: { processed: 1, total: 4, percentage: 25 },
    });

    expect(reply).toMatchObject({ success: false, code: "INDEX_REBUILDING" });
  });

  it("answers normally when the index is whole", async () => {
    const reply = await answerFor({}, [{ chatId: "c1", messageId: "m1" }]);

    expect(reply).toMatchObject({ id: "r1", success: true });
  });
});
