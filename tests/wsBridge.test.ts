import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/utils/logger";

const searchChatsStreaming = vi.hoisted(() => vi.fn());
const getCliSettings = vi.hoisted(() => vi.fn());

vi.mock("../src/services/syncService", () => ({ SyncService: { searchChatsStreaming } }));
vi.mock("../src/services/settingsService", () => ({ getCliSettings }));
vi.mock("../src/services/importService", () => ({ ImportService: {} }));
vi.mock("../src/services/metadataRepository", () => ({
  getMany: vi.fn(async () => new Map()),
}));
vi.mock("../src/services/metadataService", () => ({ generateOnRequest: vi.fn() }));
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
// chrome.storage.session, which keeps the bridge's "gave up" across service worker restarts
let sessionStore: Record<string, unknown> = {};
const sessionStorage = {
  get: async (key: string) => (key in sessionStore ? { [key]: sessionStore[key] } : {}),
  set: async (items: Record<string, unknown>) => {
    Object.assign(sessionStore, items);
  },
  remove: async (key: string) => {
    delete sessionStore[key];
  },
};

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
  sessionStore = {};
  searchChatsStreaming.mockReset();
  alarms.create.mockClear();
  alarms.clear.mockClear();
  vi.mocked(log.warn).mockClear();
  getCliSettings.mockReset();
  getCliSettings.mockResolvedValue({ enabled: true, port: 5517, apiKey: "key" });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", { alarms, storage: { session: sessionStorage } });
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
    // The reader gets the sentence, not the JavaScript error behind it.
    expect(reply.error).toContain("the last rebuild failed");
    expect(reply.error).not.toContain("boom");
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

describe("the bridge after the daemon closes it (HVN-44)", () => {
  async function connectedBridge(): Promise<{ bridge: Bridge; socket: FakeWebSocket }> {
    const bridge = await loadBridge();
    await bridge.applyWsBridgeSettings();
    const socket = latest();
    socket.accept();
    return { bridge, socket };
  }

  /** Let timers and the promises they start run, as time passes. */
  async function pass(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reconnects after an ordinary close, with a growing delay", async () => {
    const { socket } = await connectedBridge();

    socket.drop(1006);
    expect(sockets()).toHaveLength(1);
    await pass(2_000);
    expect(sockets()).toHaveLength(2);

    latest().drop(1006);
    await pass(2_000);
    expect(sockets()).toHaveLength(2); // the second wait is longer
    await pass(2_000);
    expect(sockets()).toHaveLength(3);
  });

  it("stops for good on close 4002 (replaced by a newer extension): no timer, no alarm, no new socket", async () => {
    const { bridge, socket } = await connectedBridge();

    socket.drop(4002);
    await pass(0);

    expect(alarms.clear).toHaveBeenCalledWith(bridge.WS_RECONNECT_ALARM);
    expect(vi.getTimerCount()).toBe(0);
    await pass(120_000);
    expect(sockets()).toHaveLength(1);

    // An alarm that was already in flight finds nothing to do.
    alarms.create.mockClear();
    bridge.handleWsReconnectAlarm();
    await pass(60_000);
    expect(sockets()).toHaveLength(1);
    expect(alarms.create).not.toHaveBeenCalled();
  });

  /** The daemon refuses the key: the socket opens, no authOk, then the close. */
  function reject(socket: FakeWebSocket, how: "frame" | "close"): void {
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
    if (how === "frame") socket.receive({ type: "authError", message: "Invalid API key" });
    socket.drop(4001);
  }

  const keyWarnings = () =>
    vi.mocked(log.warn).mock.calls.filter(([text]) => String(text).includes("Cannot connect"));

  for (const how of ["frame", "close"] as const) {
    it(`keeps trying after a rejected key (${how}), slowly: 30 s, doubling to 5 min`, async () => {
      const bridge = await loadBridge();
      await bridge.applyWsBridgeSettings();

      const waits = [30, 60, 120, 240, 300, 300];
      for (const [i, seconds] of waits.entries()) {
        reject(latest(), how);
        const count = sockets().length;
        await pass(seconds * 1000 - 1);
        expect(sockets()).toHaveLength(count); // not a moment early, alarm ticks or not
        bridge.handleWsReconnectAlarm(); // the 30 s alarm ticks inside the wait
        await pass(0);
        expect(sockets()).toHaveLength(count);
        await pass(1);
        expect(sockets()).toHaveLength(count + 1);
        expect(keyWarnings()).toHaveLength(i + 1); // one warning per try, the reason in it
      }
      expect(String(keyWarnings()[0][0])).toContain("API key");
      expect(alarms.clear).not.toHaveBeenCalled(); // the alarm stays: it finds the daemon again
    });
  }

  it("counts one rejection as one try when the close follows the authError frame", async () => {
    const bridge = await loadBridge();
    await bridge.applyWsBridgeSettings();
    const first = latest();
    first.readyState = FakeWebSocket.OPEN;
    first.onopen?.();
    first.receive({ type: "authError", message: "Invalid API key" });
    first.drop(4001); // nobody listens any more

    await pass(30_000);
    expect(sockets()).toHaveLength(2);
    reject(latest(), "frame");
    await pass(59_999);
    expect(sockets()).toHaveLength(2); // the second wait is 60 s, not 120
    await pass(1);
    expect(sockets()).toHaveLength(3);
    expect(keyWarnings()).toHaveLength(2);
  });

  it("recovers by itself when the daemon is restarted with the key, and starts over at 30 s", async () => {
    const bridge = await loadBridge();
    await bridge.applyWsBridgeSettings();
    reject(latest(), "frame");
    await pass(30_000);
    reject(latest(), "frame");
    await pass(60_000);
    expect(sockets()).toHaveLength(3);

    latest().accept(); // the daemon has the right key now
    latest().drop(1006);
    await pass(2_000);
    expect(sockets()).toHaveLength(4); // an ordinary close, an ordinary reconnect

    reject(latest(), "close");
    await pass(30_000); // the backoff began again
    expect(sockets()).toHaveLength(5);
  });

  it("connects at once when the settings change during the slow backoff", async () => {
    const bridge = await loadBridge();
    await bridge.applyWsBridgeSettings();
    reject(latest(), "frame");
    expect(sockets()).toHaveLength(1);

    await bridge.resetWsBridge(); // a new key or port, or the switch

    expect(sockets()).toHaveLength(2);
  });

  it("resumes when the settings are reset (enable, port or key changed)", async () => {
    const { bridge, socket } = await connectedBridge();
    socket.drop(4002);
    await pass(0);

    await bridge.resetWsBridge();

    expect(sockets()).toHaveLength(2);
    expect(alarms.create).toHaveBeenCalled();
    latest().accept();
    latest().drop(1006); // and it is an ordinary bridge again: this one reconnects
    await pass(2_000);
    expect(sockets()).toHaveLength(3);
  });

  it("stays stopped across a service worker restart, and resumes on reset", async () => {
    const { socket } = await connectedBridge();
    socket.drop(4002);
    await pass(0);

    const restarted = await loadBridge(); // a new module: the in-memory state is gone
    await restarted.applyWsBridgeSettings();
    expect(sockets()).toHaveLength(1);

    await restarted.resetWsBridge();
    expect(sockets()).toHaveLength(2);
  });

  it("does not connect while the stop is still being read from storage", async () => {
    const { socket } = await connectedBridge();
    socket.drop(4002);
    await pass(0);

    const restarted = await loadBridge();
    const realGet = sessionStorage.get;
    vi.spyOn(sessionStorage, "get").mockImplementation(async (key: string) => {
      await new Promise((r) => setTimeout(r, 50)); // storage is slow at a wake
      return realGet(key);
    });
    // At a wake the init call and the alarm listener both apply the settings.
    const first = restarted.applyWsBridgeSettings();
    const second = restarted.applyWsBridgeSettings();
    await pass(100);
    await Promise.all([first, second]);

    expect(sockets()).toHaveLength(1);
  });

  it("is not stopped by a restart when the bridge never gave up", async () => {
    const { socket } = await connectedBridge();
    socket.drop(1006);
    await pass(0);

    const restarted = await loadBridge();
    await restarted.applyWsBridgeSettings();

    expect(sockets().length).toBeGreaterThan(1);
  });
});
