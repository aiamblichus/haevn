// Central message router that delegates to specific handlers

import { diagnosticsService } from "../../services/diagnosticsService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { isBackgroundRequest } from "../../types/messaging";
import { log } from "../../utils/logger";
import * as chatHandlers from "./chatHandlers";
import * as exportHandlers from "./exportHandlers";
import * as galleryHandlers from "./galleryHandlers";
import * as importHandlers from "./importHandlers";
import * as loggerHandlers from "./loggerHandlers";
import * as mediaHandlers from "./mediaHandlers";
import * as metadataHandlers from "./metadataHandlers";
import * as miscHandlers from "./miscHandlers";
import * as searchHandlers from "./searchHandlers";
import * as settingsHandlers from "./settingsHandlers";
import * as syncHandlers from "./syncHandlers";

// Handler function type that accepts the full union and narrows internally
type HandlerFunction = (
  message: BackgroundRequest,
  sendResponse: (response: BackgroundResponse) => void,
) => void | Promise<void>;

// Type-safe handler map - each handler will narrow the message type internally
// We use type assertions here because the router ensures the correct message type at runtime
const handlers: Partial<Record<BackgroundRequest["action"], HandlerFunction>> = {
  syncCurrentChat: syncHandlers.handleSyncCurrentChat as HandlerFunction,
  syncChatByUrl: syncHandlers.handleSyncChatByUrl as HandlerFunction,
  startBulkSync: syncHandlers.handleStartBulkSync as HandlerFunction,
  startBulkSyncFromTab: syncHandlers.handleStartBulkSyncFromTab as HandlerFunction,
  cancelBulkSync: syncHandlers.handleCancelBulkSync as HandlerFunction,
  getBulkSyncState: syncHandlers.handleGetBulkSyncState as HandlerFunction,
  resumeBulkSync: syncHandlers.handleResumeBulkSync as HandlerFunction,
  abandonBulkSync: syncHandlers.handleAbandonBulkSync as HandlerFunction,
  forceResetBulkSync: syncHandlers.handleForceResetBulkSync as HandlerFunction,
  getSyncedChatsMetadata: chatHandlers.handleGetSyncedChatsMetadata as HandlerFunction,
  getSyncedChatContent: chatHandlers.handleGetSyncedChatContent as HandlerFunction,
  deleteSyncedChats: chatHandlers.handleDeleteSyncedChats as HandlerFunction,
  existsChat: chatHandlers.handleExistsChat as HandlerFunction,
  checkForChanges: chatHandlers.handleCheckForChanges as HandlerFunction,
  checkCurrentChatSynced: chatHandlers.handleCheckCurrentChatSynced as HandlerFunction,
  getProviderStats: chatHandlers.handleGetProviderStats as HandlerFunction,
  exportSyncedChat: exportHandlers.handleExportSyncedChat as HandlerFunction,
  startBulkExport: exportHandlers.handleStartBulkExport as HandlerFunction,
  cancelBulkExport: exportHandlers.handleCancelBulkExport as HandlerFunction,
  pauseBulkExport: exportHandlers.handlePauseBulkExport as HandlerFunction,
  resumeBulkExport: exportHandlers.handleResumeBulkExport as HandlerFunction,
  downloadFile: exportHandlers.handleDownloadFile as HandlerFunction,
  searchChats: searchHandlers.handleSearchChats as HandlerFunction,
  rebuildIndex: searchHandlers.handleRebuildIndex as HandlerFunction,
  searchChatsStreaming: searchHandlers.handleSearchChatsStreaming as HandlerFunction,
  cancelSearchStreaming: searchHandlers.handleCancelSearchStreaming as HandlerFunction,
  getAllMatchesForChat: searchHandlers.handleGetAllMatchesForChat as HandlerFunction,
  saveImportedChat: importHandlers.handleSaveImportedChat as HandlerFunction,
  startBulkIndexing: importHandlers.handleStartBulkIndexing as HandlerFunction,
  finishBulkIndexing: importHandlers.handleFinishBulkIndexing as HandlerFunction,
  startImportJob: importHandlers.handleStartImportJob as HandlerFunction,
  pauseImportJob: importHandlers.handlePauseImportJob as HandlerFunction,
  resumeImportJob: importHandlers.handleResumeImportJob as HandlerFunction,
  cancelImportJob: importHandlers.handleCancelImportJob as HandlerFunction,
  getImportJobState: importHandlers.handleGetImportJobState as HandlerFunction,
  countImportConversations: importHandlers.handleCountImportConversations as HandlerFunction,
  getGalleryMedia: galleryHandlers.handleGetGalleryMedia as HandlerFunction,
  getGalleryContent: galleryHandlers.handleGetGalleryContent as HandlerFunction,
  checkMissingThumbnails: galleryHandlers.handleCheckMissingThumbnails as HandlerFunction,
  getOpenWebUIBaseUrl: settingsHandlers.handleGetOpenWebUIBaseUrl as HandlerFunction,
  setOpenWebUIBaseUrl: settingsHandlers.handleSetOpenWebUIBaseUrl as HandlerFunction,
  clearOpenWebUIBaseUrl: settingsHandlers.handleClearOpenWebUIBaseUrl as HandlerFunction,
  getCliSettings: settingsHandlers.handleGetCliSettings as HandlerFunction,
  setCliEnabled: settingsHandlers.handleSetCliEnabled as HandlerFunction,
  setCliPort: settingsHandlers.handleSetCliPort as HandlerFunction,
  regenerateCliApiKey: settingsHandlers.handleRegenerateCliApiKey as HandlerFunction,
  getMediaContent: mediaHandlers.handleGetMediaContent as HandlerFunction,
  deleteMedia: mediaHandlers.handleDeleteMedia as HandlerFunction,
  getMediaStats: mediaHandlers.handleGetMediaStats as HandlerFunction,
  getLogs: loggerHandlers.handleGetLogs as HandlerFunction,
  getLoggerConfig: loggerHandlers.handleGetLoggerConfig as HandlerFunction,
  setLoggerConfig: loggerHandlers.handleSetLoggerConfig as HandlerFunction,
  clearLogs: loggerHandlers.handleClearLogs as HandlerFunction,
  closeTab: miscHandlers.handleCloseTab as HandlerFunction,
  reload: miscHandlers.handleReload as HandlerFunction,
  getChatMetadata: metadataHandlers.handleGetChatMetadata as HandlerFunction,
  getMetadataForChats: metadataHandlers.handleGetMetadataForChats as HandlerFunction,
  setChatMetadata: metadataHandlers.handleSetChatMetadata as HandlerFunction,
  generateChatMetadata: metadataHandlers.handleGenerateChatMetadata as HandlerFunction,
  getMetadataAIConfig: metadataHandlers.handleGetMetadataAIConfig as HandlerFunction,
  setMetadataAIConfig: metadataHandlers.handleSetMetadataAIConfig as HandlerFunction,
  queueMissingMetadata: metadataHandlers.handleQueueMissingMetadata as HandlerFunction,
  getMetadataQueueStatus: metadataHandlers.handleGetMetadataQueueStatus as HandlerFunction,
  rebuildAllMetadata: metadataHandlers.handleRebuildAllMetadata as HandlerFunction,
  getChatPreview: metadataHandlers.handleGetChatPreview as HandlerFunction,
};

export function handleMessage(
  message: unknown,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundResponse) => void,
): boolean {
  // Skip messages without action field (internal messages like workerMessage, etc.)
  if (!isBackgroundRequest(message)) {
    return false;
  }

  const handler = handlers[message.action];
  if (!handler) {
    log.warn(`Unknown action: ${message.action}`);
    return false;
  }

  const opId = diagnosticsService.trackOperation(message.action, {
    sender: _sender.url,
  });

  let result: boolean | Promise<unknown>;
  try {
    result = handler(message, sendResponse) as boolean | Promise<unknown>;
  } catch (err) {
    // Synchronous error in handler
    diagnosticsService.endOperation(opId);
    log.error(`Handler crashed synchronously: ${message.action}`, err);
    return false;
  }

  // If handler returns a promise, we need to keep the channel open
  if (result instanceof Promise) {
    result
      .catch((err) => {
        log.error("Handler promise rejected", err);
        sendResponse({ success: false, error: err?.message || "Handler failed" });
      })
      .finally(() => {
        diagnosticsService.endOperation(opId);
      });
    return true;
  }

  // For synchronous handlers that don't call sendResponse immediately,
  // we still need to return true to keep the channel open
  diagnosticsService.endOperation(opId);
  log.debug("Handler returned synchronously");
  return true;
}
