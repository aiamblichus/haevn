// Alarm listener for bulk sync and bulk export operations

import { diagnosticsService } from "../../services/diagnosticsService";
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
    }
  });
}
