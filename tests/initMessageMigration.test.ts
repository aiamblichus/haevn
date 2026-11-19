// The service worker's start (init.ts) checks for missing thumbnails. A thumbnail is made from the
// messages in their table, so the check waits for the move of old messages (HVN-31) only while
// the move is not done. The start runs at import, so its dependencies are stubbed here, and the
// search index opens when the test says so.
import { afterEach, describe, expect, it, vi } from "vitest";

const thumbnails = vi.hoisted(() => ({ check: vi.fn(async () => undefined) }));
const index = vi.hoisted(() => ({ open: undefined as Promise<void> | undefined }));

vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleCheckMissingThumbnails: thumbnails.check,
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: { init: () => index.open },
}));
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
vi.mock("../src/background/bulkSync/bulkSync", () => ({ resumeBulkSync: async () => {} }));
vi.mock("../src/background/bulkSync/stateManager", () => ({
  bulkSyncStateManager: { checkForIncompleteSync: async () => null },
}));
vi.mock("../src/background/state", () => ({ clearStaleOperationLocks: async () => {} }));
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

/**
 * Starts the service worker with the move's flag as given (unset when undefined). The search index
 * stays closed until the returned function is called.
 */
async function startWorker(flag?: string): Promise<() => void> {
  vi.resetModules();
  const storage = await import("../src/storage");
  storage.setStorageAdapter(new storage.MemoryStorageAdapter());
  if (flag !== undefined) {
    const { MESSAGE_MIGRATION_FLAG } = await import("../src/services/messageMigration");
    await storage.getStorageAdapter().set(MESSAGE_MIGRATION_FLAG, flag);
  }
  let openIndex = () => {};
  index.open = new Promise<void>((resolve) => {
    openIndex = resolve;
  });
  vi.stubGlobal("chrome", { alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } } });
  await import("../src/background/init");
  return () => openIndex();
}

afterEach(() => {
  vi.unstubAllGlobals();
  thumbnails.check.mockClear();
  index.open = undefined;
});

describe("the thumbnail check and the message move at start (HVN-31)", () => {
  it("does not wait on the search index once the move is done", async () => {
    await startWorker("done");

    // The index never opens in this test, so only a check that does not wait on it runs.
    await vi.waitFor(() => expect(thumbnails.check).toHaveBeenCalledTimes(1));
  });

  it("waits for the move, and so for the index, while the move is not done", async () => {
    const openIndex = await startWorker();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thumbnails.check).not.toHaveBeenCalled();

    openIndex();
    await vi.waitFor(() => expect(thumbnails.check).toHaveBeenCalledTimes(1));
  });
});
