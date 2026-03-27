// Export message handlers

import type { ExportOptions } from "../../formatters";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";
import {
  cancelBulkExport,
  pauseBulkExport,
  resumeBulkExport,
  startBulkExport,
} from "../bulkExport/bulkExport";
import { getExporter, normalizeExportOptions } from "../export/exporters";
import { exportSingleChatFile } from "../export/singleChatExport";
import { handleFileDownload } from "../utils/fileDownload";

export async function handleExportSyncedChat(
  message: Extract<BackgroundRequest, { action: "exportSyncedChat" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const options: ExportOptions = normalizeExportOptions(message.options);
    const exporter = getExporter(options.exporterId || "haevn_zip");

    if (exporter.outputKind === "zip") {
      await startBulkExport([message.chatId], options);
      sendResponse({ success: true, message: "Bulk export started" });
      return;
    }

    const result = await exportSingleChatFile(message.chatId, options);
    sendResponse({
      success: true,
      message: `Exported ${result.filename}`,
      downloadId: result.downloadId,
    });
  } catch (err: unknown) {
    log.error("[ExportHandler] Export failed:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Export failed",
    });
  }
}

export function handleDownloadFile(
  message: Extract<BackgroundRequest, { action: "downloadFile" }>,
  sendResponse: (response: BackgroundResponse) => void,
): void {
  handleFileDownload(message, sendResponse);
}

export async function handleStartBulkExport(
  message: Extract<BackgroundRequest, { action: "startBulkExport" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const chatIds: string[] = message.chatIds || [];
    const options: ExportOptions = normalizeExportOptions(message.options);
    const exporter = getExporter(options.exporterId || "haevn_zip");

    if (!exporter.supportsMultiChat && chatIds.length > 1) {
      throw new Error(
        `Exporter "${exporter.label}" does not support multi-chat export. Select one chat.`,
      );
    }

    if (exporter.outputKind === "zip") {
      await startBulkExport(chatIds, options);
      sendResponse({
        success: true,
        message: "Bulk export started",
      });
      return;
    }

    if (chatIds.length !== 1) {
      throw new Error(`Exporter "${exporter.label}" requires exactly one chat.`);
    }

    const result = await exportSingleChatFile(chatIds[0], options);
    sendResponse({
      success: true,
      message: `Exported ${result.filename}`,
      downloadId: result.downloadId,
    });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to start bulk export",
    });
  }
}

export async function handleCancelBulkExport(
  _message: Extract<BackgroundRequest, { action: "cancelBulkExport" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await cancelBulkExport();
    sendResponse({
      success: true,
      message: "Bulk export canceled",
    });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to cancel bulk export",
    });
  }
}

export async function handlePauseBulkExport(
  _message: Extract<BackgroundRequest, { action: "pauseBulkExport" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await pauseBulkExport();
    sendResponse({
      success: true,
      message: "Bulk export paused",
    });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to pause bulk export",
    });
  }
}

export async function handleResumeBulkExport(
  _message: Extract<BackgroundRequest, { action: "resumeBulkExport" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await resumeBulkExport();
    sendResponse({
      success: true,
      message: "Bulk export resumed",
    });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to resume bulk export",
    });
  }
}
