// Main bulk sync entry point for the background service worker.
// Delegates orchestration to orchestrator.ts and worker messaging to workerHandler.ts.

import {
  BULK_SYNC_ALARM_NAME,
  cancelSyncWorker,
  cleanupBulkSync,
  handleBulkSync,
  handleBulkSyncTick,
  resumeBulkSync,
  startBulkSync,
} from "./orchestrator";
import { handleWorkerMessage } from "./workerHandler";

// Set up listener for worker messages forwarded from offscreen document
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.type === "workerMessage" && message.workerType === "bulkSync") {
    handleWorkerMessage(message.data);
  }
  return false; // Not handling response
});

// Export orchestration functions for use by other background handlers
export {
  BULK_SYNC_ALARM_NAME,
  startBulkSync,
  resumeBulkSync,
  handleBulkSyncTick,
  cancelSyncWorker,
  cleanupBulkSync,
  handleBulkSync,
};
