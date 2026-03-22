// Initialize providers and services
import "./bootstrap";
import "./init";
import { log } from "../utils/logger";

log.debug("HAEVN Background script loaded");

import { loggerService } from "../services/loggerService";
import { isLogMessage } from "../types/messaging";

// Set up message handler
import { handleMessage } from "./handlers";
import { setupAlarmListener } from "./listeners/alarmListener";
// Set up event listeners
import { setupInstallationListener } from "./listeners/installationListener";
import { setupLifecycleListeners } from "./listeners/lifecycleListeners";

// Initialize listeners
setupInstallationListener();
setupLifecycleListeners();
setupAlarmListener();

// Handle messages from content scripts or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle LOG messages directly (bypass router)
  if (isLogMessage(message)) {
    loggerService.addLog(message.data, sender);
    // No response needed for log messages
    return false;
  }

  // Forward worker requests to offscreen document
  // Three-Tier Architecture: Service Worker → Offscreen Document → Web Workers
  if (message.type === "workerRequest") {
    // Forward to offscreen document
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
      } else {
        sendResponse(response);
      }
    });
    return true; // Keep channel open for async response
  }

  // Handle worker messages forwarded from offscreen document (progress updates, etc.)
  // These are handled by specific listeners (e.g., bulkExport.ts)
  if (message.type === "workerMessage") {
    // These are fire-and-forget progress updates, no response needed
    return false;
  }

  // Handle other messages via centralized router
  return handleMessage(message, sender, sendResponse);
});
