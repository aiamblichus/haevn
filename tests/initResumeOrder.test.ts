// The service worker's start (init.ts) clears the stale operation locks and resumes an interrupted
// bulk sync. The lock the interrupted run held is still in storage at that moment, so the resume
// must come after the clearing: before it, the resume finds the lock taken (and gives up), or takes
// it and has it cleared under it (HVN-124). The start runs at import, so its dependencies are
// stubbed here and record the order they were called in.
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  order: [] as string[],
  clearLocks: undefined as (() => Promise<void>) | undefined,
  incomplete: { provider: "chatgpt", processedChatIds: [], total: 3 } as unknown,
}));

vi.mock("../src/background/state", () => ({
  clearStaleOperationLocks: () => {
    calls.order.push("clear:start");
    return (calls.clearLocks ?? (async () => {}))().then(() => {
      calls.order.push("clear:end");
    });
  },
}));
vi.mock("../src/background/bulkSync/bulkSync", () => ({
  resumeBulkSync: async (provider: string) => {
    calls.order.push(`resume:${provider}`);
  },
}));
vi.mock("../src/background/bulkSync/stateManager", () => ({
  bulkSyncStateManager: {
    checkForIncompleteSync: async () => {
      calls.order.push("check");
      return calls.incomplete;
    },
  },
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleCheckMissingThumbnails: async () => undefined,
}));
vi.mock("../src/services/syncService", () => ({ SyncService: { init: async () => undefined } }));
vi.mock("../src/services/diagnosticsService", () => ({
  diagnosticsService: { wrap: (_name: string, fn: () => Promise<unknown>) => fn() },
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/background/import/importOrchestrator", () => ({
  clearStaleImportState: async () => {},
}));
vi.mock("../src/providers/index", () => ({ registerAllProviders: () => {} }));
vi.mock("../src/providers/provider", () => ({
  getAllProviders: () => [],
  getProvider: () => undefined,
}));
vi.mock("../src/services/cacheService", () => ({
  CacheService: { initializeProviderStats: async () => {} },
}));
vi.mock("../src/background/bulkExport/bulkExport", () => ({
  sweepOrphanedExports: async () => {},
}));
vi.mock("../src/background/wsBridge", () => ({
  initWsBridge: () => {},
  handleWsReconnectAlarm: () => {},
  WS_RECONNECT_ALARM: "ws-reconnect",
}));
vi.mock("../src/services/janitorService", () => ({
  JanitorService: {
    cleanupSoftDeletedChats: async () => {},
    sweepMediaIfDue: async () => {},
  },
}));
vi.mock("../src/services/messageMigration", () => ({
  isMessageMigrationDone: async () => true,
  runMessageMigration: async () => undefined,
}));

async function startWorker(): Promise<void> {
  vi.resetModules();
  vi.stubGlobal("chrome", { alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } } });
  await import("../src/background/init");
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.order.length = 0;
  calls.clearLocks = undefined;
  calls.incomplete = { provider: "chatgpt", processedChatIds: [], total: 3 };
});

describe("the resume of an interrupted bulk sync at start", () => {
  it("waits until the stale locks are cleared", async () => {
    let finishClearing = () => {};
    calls.clearLocks = () =>
      new Promise<void>((resolve) => {
        finishClearing = resolve;
      });

    await startWorker();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.order).toEqual(["clear:start"]);

    finishClearing();
    await vi.waitFor(() => expect(calls.order).toContain("resume:chatgpt"));
    expect(calls.order).toEqual(["clear:start", "clear:end", "check", "resume:chatgpt"]);
  });

  it("still resumes when clearing the locks failed", async () => {
    calls.clearLocks = async () => {
      throw new Error("storage unavailable");
    };

    await startWorker();

    await vi.waitFor(() => expect(calls.order).toContain("resume:chatgpt"));
    expect(calls.order.indexOf("resume:chatgpt")).toBeGreaterThan(calls.order.indexOf("check"));
  });

  it("resumes nothing when no run was interrupted", async () => {
    calls.incomplete = null;

    await startWorker();
    await vi.waitFor(() => expect(calls.order).toContain("check"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.order).toEqual(["clear:start", "clear:end", "check"]);
  });
});
