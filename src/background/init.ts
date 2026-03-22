import { clearStaleImportState } from "../background/import/importOrchestrator";
import { registerAllProviders } from "../providers/index";
import { getProvider } from "../providers/provider";
import { CacheService } from "../services/cacheService";
import { diagnosticsService } from "../services/diagnosticsService";
import { SyncService } from "../services/syncService";
import { log } from "../utils/logger";
import { resumeBulkSync } from "./bulkSync/bulkSync";
import { bulkSyncStateManager } from "./bulkSync/stateManager";
import { handleCheckMissingThumbnails } from "./handlers/galleryHandlers";
import { clearStaleOperationLocks } from "./state";

// Initialize storage adapter is now handled in bootstrap.ts (imported first in background.ts)

// Register all providers
registerAllProviders();

// Clear any stale operation locks and states on startup (from crashed/interrupted operations)
clearStaleOperationLocks().catch((err) => log.warn("Failed to clear stale operation locks", err));
clearStaleImportState().catch((err) => log.warn("Failed to clear stale import state", err));

// Resume interrupted bulk sync automatically after service worker restart.
// The state manager validates staleness and only returns fresh resumable state.
(async () => {
  try {
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

const PROVIDERS = [
  "gemini",
  "claude",
  "poe",
  "chatgpt",
  "openwebui",
  "qwen",
  "aistudio",
  "deepseek",
  "grok",
];

// Initialize SyncService (loads or builds Lunr index, etc.)
diagnosticsService
  .wrap("init:SyncService", () => SyncService.init())
  .catch((err) => log.warn("SyncService init failed", err));

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
    log.info("Checking for missing thumbnails...");
    await diagnosticsService.wrap("init:Thumbnails", () => handleCheckMissingThumbnails(undefined));
  } catch (err) {
    log.warn("Thumbnail check failed", err);
  }
})();

// Initialize Janitor for soft-delete cleanup
import { JanitorService } from "../services/janitorService";

// Run Janitor cleanup on startup (fire-and-forget)
diagnosticsService
  .wrap("init:Janitor", () => JanitorService.cleanupSoftDeletedChats())
  .catch((err) => log.error("[Janitor] Cleanup failed", err));

// Set up periodic cleanup via chrome.alarms (every 30 minutes)
const JANITOR_ALARM_NAME = "janitor-cleanup";
chrome.alarms.create(JANITOR_ALARM_NAME, { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JANITOR_ALARM_NAME) {
    diagnosticsService
      .wrap("alarm:Janitor", () => JanitorService.cleanupSoftDeletedChats())
      .catch((err) => {
        log.error("[Janitor] Cleanup failed", err);
      });
  }
});
