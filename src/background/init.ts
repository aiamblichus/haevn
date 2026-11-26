import { clearStaleImportState } from "../background/import/importOrchestrator";
import { registerAllProviders } from "../providers/index";
import { getAllProviders, getProvider } from "../providers/provider";
import { CacheService } from "../services/cacheService";
import { diagnosticsService } from "../services/diagnosticsService";
import { isMessageMigrationDone, runMessageMigration } from "../services/messageMigration";
import { runProviderModifiedBackfill } from "../services/providerModifiedBackfill";
import { SyncService } from "../services/syncService";
import { log } from "../utils/logger";
import { sweepOrphanedExports } from "./bulkExport/bulkExport";
import { resumeBulkSync } from "./bulkSync/bulkSync";
import { bulkSyncStateManager } from "./bulkSync/stateManager";
import { handleCheckMissingThumbnails } from "./handlers/galleryHandlers";
import { clearStaleOperationLocks } from "./state";
import { handleWsReconnectAlarm, initWsBridge, WS_RECONNECT_ALARM } from "./wsBridge";

// Initialize storage adapter is now handled in bootstrap.ts (imported first in background.ts)

// Register all providers
registerAllProviders();

// Connect to the HAEVN CLI daemon via WebSocket (no-op if daemon is not running).
initWsBridge();

// Clear any stale operation locks and states on startup (from crashed/interrupted operations)
const staleLocksCleared = clearStaleOperationLocks().catch((err) =>
  log.warn("Failed to clear stale operation locks", err),
);
clearStaleImportState().catch((err) => log.warn("Failed to clear stale import state", err));

// Resume interrupted bulk sync automatically after service worker restart.
// The state manager validates staleness and only returns fresh resumable state.
// It waits for the locks to be cleared: the lock the interrupted run held is still in storage, and
// a resume that took it before the clearing would find it taken, or have it cleared under it (HVN-124).
(async () => {
  try {
    await staleLocksCleared;
    const incompleteSync = await bulkSyncStateManager.checkForIncompleteSync();
    if (!incompleteSync) return;

    log.info("[Init] Resuming interrupted bulk sync", {
      provider: incompleteSync.provider,
      processed: incompleteSync.processedChatIds.length,
      total: incompleteSync.total,
    });
    await resumeBulkSync(incompleteSync.provider);
  } catch (err) {
    log.warn("[Init] Failed to auto-resume bulk sync", err);
  }
})();

// LoggerService initialization is now handled in bootstrap.ts

// Every registered provider, import-only ones included (setup and the stats cache cover them all).
const PROVIDERS = getAllProviders().map((provider) => provider.name);

// Initialize SyncService (opens or builds the search index, etc.)
const searchReady = diagnosticsService
  .wrap("init:SyncService", () => SyncService.init())
  .catch((err) => log.warn("SyncService init failed", err));

// Move the messages of chats saved before DB v17 into their table (HVN-31). It starts once the index
// is open, so each chat it moves is indexed by a worker that is listening. After its flag is set, a
// start only reads the flag.
const messagesMoved = searchReady
  .then(() => diagnosticsService.wrap("init:MessageMigration", () => runMessageMigration()))
  .catch((err) => log.error("[Init] Message migration failed", err));

// Give the chats stored without a modified time one, so the "Modified Time" sort lists them
// (HVN-165). It needs no index, and after its flag is set a start only reads the flag.
void diagnosticsService
  .wrap("init:ProviderModifiedBackfill", () => runProviderModifiedBackfill())
  .catch((err) => log.error("[Init] Provider-modified backfill failed", err));

// Call setup for every provider synchronously to ensure listeners are registered early
try {
  for (const provider of PROVIDERS) {
    const providerInstance = getProvider(provider);
    if (providerInstance?.setup) {
      // Setup might be async but we don't need to wait for it to continue registration
      providerInstance.setup();
    }
  }
} catch (err) {
  log.error("[Init] Provider setup loop failed", err);
}

// Initialize provider stats cache in background (non-blocking)
(async () => {
  try {
    await diagnosticsService.wrap("init:CacheService", () =>
      CacheService.initializeProviderStats(PROVIDERS),
    );
  } catch (err) {
    log.warn("ProviderStats initialization failed", err);
  }
})();

// Check for missing thumbnails and generate in background (non-blocking)
(async () => {
  try {
    // A thumbnail is made from the messages in their table, so until the move is done the check
    // waits for it. Once the flag says it is done, the check does not wait on the index.
    if (!(await isMessageMigrationDone())) await messagesMoved;
    log.info("Checking for missing thumbnails...");
    await diagnosticsService.wrap("init:Thumbnails", () => handleCheckMissingThumbnails(undefined));
  } catch (err) {
    log.warn("Thumbnail check failed", err);
  }
})();

// Initialize Janitor for soft-delete cleanup
import { JanitorService } from "../services/janitorService";

/**
 * One Janitor run: the hard deletes, then the media sweep (after them, so the folders they leave
 * behind are in the sweep's first look). The sweep runs when the deletes failed too, and the
 * failure is still thrown for the caller to log: a chunk that never deletes must not stop the
 * sweep for good (HVN-146).
 */
async function runJanitor(): Promise<void> {
  try {
    await JanitorService.cleanupSoftDeletedChats();
  } finally {
    await JanitorService.sweepMediaIfDue();
  }
}

// Run Janitor cleanup on startup (fire-and-forget)
diagnosticsService
  .wrap("init:Janitor", runJanitor)
  .catch((err) => log.error("[Janitor] Cleanup failed", err));

// The same rhythm sweeps the orphans of bulk exports in OPFS (HVN-62).
diagnosticsService
  .wrap("init:ExportSweep", () => sweepOrphanedExports())
  .catch((err) => log.warn("[BulkExport] Sweep of stale exports failed", err));

// Set up periodic cleanup via chrome.alarms (every 30 minutes)
const JANITOR_ALARM_NAME = "janitor-cleanup";
chrome.alarms.create(JANITOR_ALARM_NAME, { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JANITOR_ALARM_NAME) {
    diagnosticsService.wrap("alarm:Janitor", runJanitor).catch((err) => {
      log.error("[Janitor] Cleanup failed", err);
    });
    diagnosticsService
      .wrap("alarm:ExportSweep", () => sweepOrphanedExports())
      .catch((err) => {
        log.warn("[BulkExport] Sweep of stale exports failed", err);
      });
  }
  if (alarm.name === WS_RECONNECT_ALARM) {
    handleWsReconnectAlarm();
  }
});
