// Alarm listener for bulk sync, bulk export, and metadata queue operations

import { diagnosticsService } from "../../services/diagnosticsService";
import {
  METADATA_PROCESS_ALARM,
  METADATA_REFRESH_ALARM,
  processQueueTick,
  refreshQueueTick,
} from "../../services/metadataService";
import { log } from "../../utils/logger";
import { handleBulkExportTick } from "../bulkExport/bulkExport";
import { handleBulkSyncTick } from "../bulkSync/bulkSync";

const BULK_SYNC_ALARM_NAME = "bulkSyncAlarm";
const BULK_EXPORT_ALARM_NAME = "bulkExportAlarm";

export function setupAlarmListener(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BULK_SYNC_ALARM_NAME) {
      diagnosticsService
        .wrap("alarm:bulkSync", () => handleBulkSyncTick())
        .catch((error: unknown) => {
          log.error("[Bulk Sync] Error in alarm tick handler:", error);
        });
    } else if (alarm.name === BULK_EXPORT_ALARM_NAME) {
      diagnosticsService
        .wrap("alarm:bulkExport", () => handleBulkExportTick())
        .catch((error: unknown) => {
          log.error("[Bulk Export] Error in alarm tick handler:", error);
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
    }
  });
}
