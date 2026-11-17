// Alarm listener for bulk sync and metadata queue operations

import { diagnosticsService } from "../../services/diagnosticsService";
import {
  EMBEDDING_PROCESS_ALARM,
  EMBEDDING_REFRESH_ALARM,
  METADATA_PROCESS_ALARM,
  METADATA_REFRESH_ALARM,
  processEmbeddingQueueTick,
  processQueueTick,
  refreshEmbeddingQueueTick,
  refreshQueueTick,
} from "../../services/metadataService";
import { log } from "../../utils/logger";
import { handleBulkSyncTick } from "../bulkSync/bulkSync";

const BULK_SYNC_ALARM_NAME = "bulkSyncAlarm";

export function setupAlarmListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BULK_SYNC_ALARM_NAME) {
      diagnosticsService
        .wrap("alarm:bulkSync", () => handleBulkSyncTick())
        .catch((error: unknown) => {
          log.error("[Bulk Sync] Error in alarm tick handler:", error);
        });
    } else if (alarm.name === METADATA_PROCESS_ALARM) {
      diagnosticsService
        .wrap("alarm:metadataQueueProcess", () => processQueueTick())
        .catch((error: unknown) => {
          log.error("[Metadata Queue] Error in process tick handler:", error);
        });
    } else if (alarm.name === METADATA_REFRESH_ALARM) {
      diagnosticsService
        .wrap("alarm:metadataQueueRefresh", () => refreshQueueTick())
        .catch((error: unknown) => {
          log.error("[Metadata Queue] Error in refresh tick handler:", error);
        });
    } else if (alarm.name === EMBEDDING_PROCESS_ALARM) {
      diagnosticsService
        .wrap("alarm:embeddingQueueProcess", () => processEmbeddingQueueTick())
        .catch((error: unknown) => {
          log.error("[Embedding Queue] Error in process tick handler:", error);
        });
    } else if (alarm.name === EMBEDDING_REFRESH_ALARM) {
      diagnosticsService
        .wrap("alarm:embeddingQueueRefresh", () => refreshEmbeddingQueueTick())
        .catch((error: unknown) => {
          log.error("[Embedding Queue] Error in refresh tick handler:", error);
        });
    }
  });
}
