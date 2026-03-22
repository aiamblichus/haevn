import { log } from "../../utils/logger";
import { getActiveOperation } from "../state";

/**
 * Sets up listeners for extension lifecycle events.
 * This helps debug when and why the service worker is being terminated.
 */
export function setupLifecycleListeners(): void {
  // Fired when the extension is first installed, updated, or Chrome is updated
  chrome.runtime.onInstalled.addListener((details) => {
    log.info(`[Lifecycle] Extension installed/updated. Reason: ${details.reason}`, details);
  });

  // Fired when a profile that has this extension installed first starts up
  chrome.runtime.onStartup.addListener(() => {
    log.info("[Lifecycle] Browser started (profile loaded)");
  });

  // Fired when the service worker is about to be suspended (terminated)
  // This is the CRITICAL event for debugging "disappearing" operations
  chrome.runtime.onSuspend.addListener(() => {
    // We can't await here because the event handler must be synchronous or
    // the suspend might happen before we finish.
    // However, logging is usually fast enough.
    // We check what operation was supposedly "active" when we got killed.
    getActiveOperation().then((op) => {
      if (op !== "idle") {
        console.warn(`[Lifecycle] Service worker suspending with ACTIVE operation: ${op}`);
      } else {
        console.info("[Lifecycle] Service worker suspending (idle)");

        // Also check if there are any active alarms or other indicators if needed
      }
    });

    console.info("[Lifecycle] Service worker suspend event received");
  });

  // Fired if the suspend event is canceled (e.g., new event comes in)
  chrome.runtime.onSuspendCanceled.addListener(() => {
    log.warn("[Lifecycle] Suspend CANCELED - Service worker staying alive");
  });
}
