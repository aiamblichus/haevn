// Import message handlers

import { ImportService } from "../../services/importService";
import * as MetadataRepository from "../../services/metadataRepository";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import type { ImportSourceType } from "../../types/workerMessages";
import { log } from "../../utils/logger";
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

    // Seed metadata from haevnMetadata field if present — only if no existing record
    if (chat.haevnMetadata && chat.id) {
      const existing = await MetadataRepository.get(chat.id);
      if (!existing) {
        const m = chat.haevnMetadata;
        await MetadataRepository.set(chat.id, {
          title: m.title ?? "",
          description: m.description ?? "",
          synopsis: m.synopsis ?? "",
          categories: m.categories ?? [],
          keywords: m.keywords ?? [],
          source: "manual",
          updatedAt: Date.now(),
        });
      }
    }

    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Save failed",
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
