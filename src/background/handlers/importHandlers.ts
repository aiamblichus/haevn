// Import message handlers

import { ImportService } from "../../services/importService";
import { SyncService } from "../../services/syncService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import type { ImportSourceType } from "../../types/workerMessages";
import { log } from "../../utils/logger";
import { errorShape } from "../../utils/logShape";
import { ImportBusyError } from "../import/importBatch";
import { importFragments } from "../import/importFragments";
import * as ImportOrchestrator from "../import/importOrchestrator";

export async function handleSaveImportedChat(
  message: Extract<BackgroundRequest, { action: "saveImportedChat" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const chat = message.chat;
    const raw = message.raw;
    const skipIndexing = message.skipIndexing ?? false;
    if (!chat?.id) {
      throw new Error("Missing chat payload or id");
    }
    await ImportService.saveImportedChat(chat, raw, { skipIndexing });

    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Save failed",
    });
  }
}

/**
 * The archive's fragment import (HVN-163): the same operation as `haevn import --format fragment`.
 * A dry run answers the plan and writes nothing; a real run answers the plan it made then and what
 * the batch did with it. A refused file is in the plan and does not stop the others.
 */
export async function handleImportFragmentFiles(
  message: Extract<BackgroundRequest, { action: "importFragmentFiles" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { files, dryRun, overwrite } = message;
    if (
      !Array.isArray(files) ||
      files.length === 0 ||
      files.some((file) => typeof file?.name !== "string" || typeof file?.content !== "string")
    ) {
      throw new Error("At least one file with a name and its text is required");
    }
    const outcome = await importFragments(files, {
      dryRun: dryRun === true,
      overwrite: overwrite !== false,
      index: true,
    });
    sendResponse({ success: true, data: outcome });
  } catch (err: unknown) {
    if (err instanceof ImportBusyError) {
      sendResponse({
        success: false,
        error: err.message,
        errorCode: "BUSY",
        activeOperation: err.activeOperation,
      });
      return;
    }
    log.error("[importHandlers] Failed to import fragments", { error: errorShape(err) });
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to import fragments",
    });
  }
}

/**
 * Start bulk indexing mode (for efficient batch imports)
 */
export async function handleStartBulkIndexing(
  _message: Extract<BackgroundRequest, { action: "startBulkIndexing" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    log.info("[importHandlers] Starting bulk indexing mode");
    await SyncService.startBulkSyncIndexing();
    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[importHandlers] Failed to start bulk indexing:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to start bulk indexing",
    });
  }
}

/**
 * Finish bulk indexing mode and rebuild index
 */
export async function handleFinishBulkIndexing(
  _message: Extract<BackgroundRequest, { action: "finishBulkIndexing" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    log.info("[importHandlers] Finishing bulk indexing mode");
    await SyncService.finishBulkSyncIndexing();
    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[importHandlers] Failed to finish bulk indexing:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to finish bulk indexing",
    });
  }
}

/**
 * Start a workerized import job
 */
export async function handleStartImportJob(
  message: Extract<BackgroundRequest, { action: "startImportJob" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { importType, stagedFilePath, originalFileName, originalFileType, overwriteExisting } =
      message;

    if (!importType || !stagedFilePath) {
      throw new Error("Missing required parameters");
    }

    await ImportOrchestrator.startImportJob(importType as ImportSourceType, stagedFilePath, {
      originalFileName,
      originalFileType,
      overwriteExisting: overwriteExisting ?? false,
    });

    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to start import job",
    });
  }
}

/**
 * Pause the current import job
 */
export async function handlePauseImportJob(
  _message: Extract<BackgroundRequest, { action: "pauseImportJob" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await ImportOrchestrator.pauseImportJob();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to pause import job",
    });
  }
}

/**
 * Resume the current import job
 */
export async function handleResumeImportJob(
  _message: Extract<BackgroundRequest, { action: "resumeImportJob" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await ImportOrchestrator.resumeImportJob();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to resume import job",
    });
  }
}

/**
 * Cancel the current import job
 */
export async function handleCancelImportJob(
  _message: Extract<BackgroundRequest, { action: "cancelImportJob" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await ImportOrchestrator.cancelImportJob();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to cancel import job",
    });
  }
}

/**
 * Get the current import job state
 */
export async function handleGetImportJobState(
  _message: Extract<BackgroundRequest, { action: "getImportJobState" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const state = await ImportOrchestrator.getImportJobState();
    sendResponse({ success: true, state });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get import job state",
    });
  }
}

/**
 * Count conversations in an import file
 */
export async function handleCountImportConversations(
  message: Extract<BackgroundRequest, { action: "countImportConversations" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { importType, stagedFilePath, originalFileName, originalFileType } = message;

    if (!importType || !stagedFilePath) {
      throw new Error("Missing required parameters");
    }

    const count = await ImportOrchestrator.countImportConversations(
      importType as ImportSourceType,
      stagedFilePath,
      {
        originalFileName,
        originalFileType,
      },
    );

    sendResponse({ success: true, count });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to count conversations",
    });
  }
}
