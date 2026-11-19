import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthDeps, ProviderHealthReport } from "../src/background/health/providerHealth";
import { acquireOperationLock, releaseOperationLock } from "../src/background/state";
import { registerAllProviders } from "../src/providers";
import type { BackgroundResponse } from "../src/types/messaging";
import { deps, FakeProbe } from "./helpers/healthProbe";

// The extension's own message (haevnDebug.providerHealth) and the CLI's bridge verb (`haevn
// health`) must run the same operation (AGENTS.md: each CLI verb calls the same service-level
// operation as its UI handler). Both are driven here, against one fake browser.

const fake = vi.hoisted(() => ({ deps: undefined as undefined | (() => HealthDeps) }));

vi.mock("../src/background/health/chromeProbe", () => ({
  chromeHealthDeps: () => (fake.deps as () => HealthDeps)(),
}));
vi.mock("../src/services/settingsService", () => ({
  getCliSettings: vi.fn(async () => ({ enabled: true, port: 5517, apiKey: "key" })),
  getMetadataAIConfig: vi.fn(),
  getStarmapConfig: vi.fn(),
  getOpenWebUIBaseUrl: vi.fn(async () => null),
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

let socket: FakeWebSocket;
let next = 0;

async function ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = `r${++next}`;
  socket.receive({ id, ...request });
  await vi.waitFor(() => expect(socket.sent.some((f) => f.id === id)).toBe(true));
  return socket.sent.find((f) => f.id === id) as Record<string, unknown>;
}

beforeAll(async () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("chrome", {
    ...(globalThis as unknown as { chrome: object }).chrome,
    alarms: { create: vi.fn(), clear: vi.fn(async () => true) },
    // the router's module graph registers listeners as it loads
    runtime: { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn(), lastError: null },
  });
  const bridge = await import("../src/background/wsBridge");
  await bridge.applyWsBridgeSettings();
  socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  socket.readyState = FakeWebSocket.OPEN;
  socket.onopen?.();
  socket.receive({ type: "authOk" });
});

beforeEach(() => {
  registerAllProviders();
  fake.deps = () => deps(new FakeProbe());
});

/** The rows of a report, without the milliseconds, which differ from run to run. */
const stable = (report: ProviderHealthReport) =>
  report.rows.map(({ ms: _ms, ...rest }) => rest);

async function viaMessage(message: Record<string, unknown>): Promise<BackgroundResponse> {
  const { handleProviderHealth } = await import("../src/background/handlers/healthHandlers");
  let answer: BackgroundResponse | undefined;
  await handleProviderHealth({ action: "providerHealth", ...message } as never, (r) => {
    answer = r;
  });
  return answer as BackgroundResponse;
}

describe("the extension's message and the CLI's bridge verb run the same operation", () => {
  it("both answer with the same nine rows", async () => {
    const message = (await viaMessage({})) as { success: true; data: ProviderHealthReport };
    const bridge = (await ask({ action: "health" })) as {
      success: boolean;
      data: ProviderHealthReport;
    };

    expect(message.success).toBe(true);
    expect(bridge.success).toBe(true);
    expect(message.data.rows).toHaveLength(9);
    expect(stable(bridge.data)).toEqual(stable(message.data));
    expect(bridge.data.extensionVersion).toBe("9.9.9");
  });

  it("both pass the options on", async () => {
    const message = (await viaMessage({ providers: ["claude"], chats: 1 })) as {
      data: ProviderHealthReport;
    };
    const bridge = (await ask({
      action: "health",
      options: { providers: ["claude"], chats: 1 },
    })) as { data: ProviderHealthReport };
    expect(message.data.rows.map((r) => [r.provider, r.checked])).toEqual([["claude", 1]]);
    expect(stable(bridge.data)).toEqual(stable(message.data));
  });

  it("both refuse an unknown provider, with the same code", async () => {
    const message = await viaMessage({ providers: ["nope"] });
    const bridge = await ask({ action: "health", options: { providers: ["nope"] } });
    expect(message).toMatchObject({ success: false, errorCode: "BAD_REQUEST" });
    expect(bridge).toMatchObject({ success: false, code: "BAD_REQUEST" });
    expect((bridge.error as string).includes("nope")).toBe(true);
  });

  it("both refuse while another operation holds the lock, and say BUSY", async () => {
    expect(await acquireOperationLock("import")).toBe(true);
    try {
      const message = await viaMessage({});
      const bridge = await ask({ action: "health" });
      expect(message).toMatchObject({ success: false, errorCode: "BUSY" });
      expect(bridge).toMatchObject({ success: false, code: "BUSY" });
    } finally {
      await releaseOperationLock("import");
    }
  });

  it("is routed by the extension's message router", async () => {
    const { handleMessage } = await import("../src/background/handlers/index");
    const answered = new Promise<BackgroundResponse>((resolve) => {
      const keepOpen = handleMessage({ action: "providerHealth", providers: ["grok"] }, {}, resolve);
      expect(keepOpen).toBe(true);
    });
    const response = (await answered) as { success: true; data: ProviderHealthReport };
    expect(response.success).toBe(true);
    expect(response.data.rows.map((r) => r.provider)).toEqual(["grok"]);
  });
});
