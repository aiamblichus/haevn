// HVN-146: the Janitor's run is the hard deletes, then the media sweep. A cleanup that fails (a chunk
// that never deletes) must not stop the sweep, at the start or on the 30-minute alarm. The start
// runs at import, so its dependencies are stubbed here.
import { afterEach, describe, expect, it, vi } from "vitest";

const janitor = vi.hoisted(() => ({
  calls: [] as string[],
  cleanup: async (): Promise<number> => 0,
}));

vi.mock("../src/background/state", () => ({ clearStaleOperationLocks: async () => {} }));
vi.mock("../src/background/bulkSync/bulkSync", () => ({ resumeBulkSync: async () => {} }));
vi.mock("../src/background/bulkSync/stateManager", () => ({
  bulkSyncStateManager: { checkForIncompleteSync: async () => null },
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
    cleanupSoftDeletedChats: async () => {
      janitor.calls.push("cleanup");
      return janitor.cleanup();
    },
    sweepMediaIfDue: async () => {
      janitor.calls.push("sweep");
      return null;
    },
  },
}));
vi.mock("../src/services/messageMigration", () => ({
  isMessageMigrationDone: async () => true,
  runMessageMigration: async () => undefined,
}));

type AlarmListener = (alarm: { name: string }) => void;

/** Starts the service worker and returns the listener it put on chrome.alarms. */
async function startWorker(): Promise<AlarmListener> {
  vi.resetModules();
  const addListener = vi.fn();
  vi.stubGlobal("chrome", { alarms: { create: vi.fn(), onAlarm: { addListener } } });
  await import("../src/background/init");
  return addListener.mock.calls[0][0] as AlarmListener;
}

afterEach(() => {
  vi.unstubAllGlobals();
  janitor.calls.length = 0;
  janitor.cleanup = async () => 0;
});

describe("the Janitor's run in init.ts", () => {
  it("sweeps after the cleanup at start", async () => {
    await startWorker();

    await vi.waitFor(() => expect(janitor.calls).toEqual(["cleanup", "sweep"]));
  });

  it("still sweeps at start when the cleanup throws", async () => {
    janitor.cleanup = async () => {
      throw new Error("Failed to hard-delete chats: bad row");
    };

    await startWorker();

    await vi.waitFor(() => expect(janitor.calls).toEqual(["cleanup", "sweep"]));
  });

  it("still sweeps on the alarm when the cleanup throws", async () => {
    const onAlarm = await startWorker();
    await vi.waitFor(() => expect(janitor.calls).toEqual(["cleanup", "sweep"]));
    janitor.calls.length = 0;
    janitor.cleanup = async () => {
      throw new Error("Failed to hard-delete chats: bad row");
    };

    onAlarm({ name: "janitor-cleanup" });

    await vi.waitFor(() => expect(janitor.calls).toEqual(["cleanup", "sweep"]));
  });
});
