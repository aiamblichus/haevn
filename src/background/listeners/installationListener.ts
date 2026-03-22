// Extension installation handler
import { log } from "../../utils/logger";

export function setupInstallationListener(): void {
  chrome.runtime.onInstalled.addListener(async (details) => {
    log.info("HAEVN Extension installed:", details.reason);

    if (details.reason === "install") {
      // Set default storage values for export preferences
      chrome.storage.sync.set({
        extensionEnabled: true,
        exportCount: 0,
      });
    }

    // Optionally migrate any legacy storage to IndexedDB (one-time)
    try {
      const { isMigrationComplete } = await chrome.storage.sync.get(["isMigrationComplete"]);
      if (!isMigrationComplete) {
        // Placeholder for actual migration logic from chrome.storage.local if present
        // const legacy = await chrome.storage.local.get(['haevnChats']);
        // if (legacy.haevnChats) { /* transform and SyncService.saveChat(...) */ }
        await chrome.storage.sync.set({ isMigrationComplete: true });
      }
    } catch (err) {
      log.warn("[Migration] Skipped or failed:", err);
    }
  });
}
