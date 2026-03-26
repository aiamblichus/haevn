import * as MetadataRepository from "../../services/metadataRepository";
import { enqueueAllMissing, generateForChat, getQueueStatus } from "../../services/metadataService";
import { getMetadataAIConfig, setMetadataAIConfig } from "../../services/settingsService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";

export async function handleGetChatMetadata(
  message: Extract<BackgroundRequest, { action: "getChatMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const record = await MetadataRepository.get(message.chatId);
    sendResponse({ success: true, data: record });
  } catch (err) {
    log.error("[MetadataHandlers] getChatMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetMetadataForChats(
  message: Extract<BackgroundRequest, { action: "getMetadataForChats" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const map = await MetadataRepository.getMany(message.chatIds);
    sendResponse({ success: true, data: Object.fromEntries(map) });
  } catch (err) {
    log.error("[MetadataHandlers] getMetadataForChats failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSetChatMetadata(
  message: Extract<BackgroundRequest, { action: "setChatMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await MetadataRepository.set(message.chatId, {
      ...message.metadata,
      source: "manual",
      updatedAt: Date.now(),
    });
    sendResponse({ success: true });
  } catch (err) {
    log.error("[MetadataHandlers] setChatMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGenerateChatMetadata(
  message: Extract<BackgroundRequest, { action: "generateChatMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const record = await generateForChat(message.chatId);
    sendResponse({ success: true, data: record });
  } catch (err) {
    log.error("[MetadataHandlers] generateChatMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetMetadataAIConfig(
  _message: Extract<BackgroundRequest, { action: "getMetadataAIConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const config = await getMetadataAIConfig();
    sendResponse({ success: true, data: config });
  } catch (err) {
    log.error("[MetadataHandlers] getMetadataAIConfig failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSetMetadataAIConfig(
  message: Extract<BackgroundRequest, { action: "setMetadataAIConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await setMetadataAIConfig(message.config);
    sendResponse({ success: true });
  } catch (err) {
    log.error("[MetadataHandlers] setMetadataAIConfig failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleQueueMissingMetadata(
  _message: Extract<BackgroundRequest, { action: "queueMissingMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const queued = await enqueueAllMissing();
    sendResponse({ success: true, data: { queued } });
  } catch (err) {
    log.error("[MetadataHandlers] queueMissingMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetMetadataQueueStatus(
  _message: Extract<BackgroundRequest, { action: "getMetadataQueueStatus" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const status = await getQueueStatus();
    sendResponse({ success: true, data: status });
  } catch (err) {
    log.error("[MetadataHandlers] getMetadataQueueStatus failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleRebuildAllMetadata(
  _message: Extract<BackgroundRequest, { action: "rebuildAllMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await MetadataRepository.clearAll();
    const queued = await enqueueAllMissing();
    log.info(`[MetadataHandlers] Rebuild all: cleared metadata, queued ${queued} chats`);
    sendResponse({ success: true, data: { queued } });
  } catch (err) {
    log.error("[MetadataHandlers] rebuildAllMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}
