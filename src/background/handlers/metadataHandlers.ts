import { ChatRepository } from "../../services/chatRepository";
import * as MetadataRepository from "../../services/metadataRepository";
import {
  apiErrorForLog,
  embeddingEndpointChanged,
  enqueueAllMissing,
  generateOnRequest,
  getEmbeddingQueueStatus,
  getQueueItem,
  getQueueStatus,
  isJsonObject,
  metadataEndpointChanged,
  pauseEmbeddingQueue,
  rebuildAllEmbeddings,
  resetAllFailed,
  resetAllFailedEmbeddings,
  resetFailedQueueItem,
  setManualMetadata,
  syncMetadataQueueAlarms,
} from "../../services/metadataService";
import {
  getMetadataAIConfig,
  getStarmapConfig,
  setMetadataAIConfig,
  setStarmapConfig,
} from "../../services/settingsService";
import { computeStarmapLayoutFromEmbeddings } from "../../services/starmapService";
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
    await setManualMetadata(message.chatId, message.metadata);
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
    const record = await generateOnRequest(message.chatId);
    sendResponse({ success: true, data: record });
  } catch (err) {
    // The endpoint's error body can echo the prompt, an excerpt of the chat: the log has the status
    log.error("[MetadataHandlers] generateChatMetadata failed", apiErrorForLog(err));
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
    // The parameters are validated here as well as in the options page, so that no other caller
    // can store a value the request cannot use. The message names no value.
    if (
      message.config.extraRequestParams !== undefined &&
      !isJsonObject(message.config.extraRequestParams)
    ) {
      sendResponse({ success: false, error: "Extra request parameters must be a JSON object" });
      return;
    }
    const before = await getMetadataAIConfig();
    await setMetadataAIConfig(message.config);
    const nextConfig = await getMetadataAIConfig();
    // A failure under the old endpoint says little about the new one, so only an actual change of
    // the URL, the model or the extra parameters resets the failed items.
    if (metadataEndpointChanged(before, nextConfig)) {
      await resetAllFailed();
    }
    await syncMetadataQueueAlarms();
    if (nextConfig.enabled && nextConfig.indexMissing) {
      await enqueueAllMissing();
    }
    sendResponse({ success: true });
  } catch (err) {
    log.error("[MetadataHandlers] setMetadataAIConfig failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetStarmapConfig(
  _message: Extract<BackgroundRequest, { action: "getStarmapConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const config = await getStarmapConfig();
    sendResponse({ success: true, data: config });
  } catch (err) {
    log.error("[MetadataHandlers] getStarmapConfig failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleSetStarmapConfig(
  message: Extract<BackgroundRequest, { action: "setStarmapConfig" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const metadataConfig = await getMetadataAIConfig();
    if (!metadataConfig.enabled) {
      sendResponse({
        success: false,
        error: "AI metadata must be enabled before configuring Starmap.",
      });
      return;
    }

    const before = await getStarmapConfig();
    await setStarmapConfig(message.config);

    const nextStarmapConfig = await getStarmapConfig();
    // Only an actual change of the embedding URL or model resets the failed items
    if (embeddingEndpointChanged(before, nextStarmapConfig)) {
      await resetAllFailedEmbeddings();
    }
    if (!nextStarmapConfig.enabled || !nextStarmapConfig.embeddingsEnabled) {
      await pauseEmbeddingQueue();
    }

    await syncMetadataQueueAlarms();
    sendResponse({ success: true });
  } catch (err) {
    log.error("[MetadataHandlers] setStarmapConfig failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetStarmapEmbeddingQueueStatus(
  _message: Extract<BackgroundRequest, { action: "getStarmapEmbeddingQueueStatus" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const status = await getEmbeddingQueueStatus();
    sendResponse({ success: true, data: status });
  } catch (err) {
    log.error("[MetadataHandlers] getStarmapEmbeddingQueueStatus failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleRebuildAllStarmapEmbeddings(
  _message: Extract<BackgroundRequest, { action: "rebuildAllStarmapEmbeddings" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const queued = await rebuildAllEmbeddings();
    sendResponse({ success: true, data: { queued } });
  } catch (err) {
    log.error("[MetadataHandlers] rebuildAllStarmapEmbeddings failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetStarmapData(
  _message: Extract<BackgroundRequest, { action: "getStarmapData" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const layout = await computeStarmapLayoutFromEmbeddings();
    const chatIds = layout.points.map((p) => p.chatId);

    const [chats, metadataMap] = await Promise.all([
      ChatRepository.getChatRows(chatIds),
      MetadataRepository.getMany(chatIds),
    ]);

    const chatById = new Map<string, (typeof chats)[number]>();
    for (const chat of chats) {
      if (chat?.id) chatById.set(chat.id, chat);
    }

    const nodes = layout.points
      .map((point) => {
        const chat = chatById.get(point.chatId);
        if (!chat || chat.deleted) return null; // embeddings outlive a soft delete
        const meta = metadataMap.get(point.chatId) ?? null;
        return {
          ...point,
          source: chat.source,
          title: chat.title,
          metaTitle: meta?.title || undefined,
          description: meta?.description || "",
          synopsis: meta?.synopsis || "",
          categories: meta?.categories ?? [],
          keywords: meta?.keywords ?? [],
          metaSource: meta?.source || "unset",
          generatedAt: meta?.generatedAt,
          metadataUpdatedAt: meta?.updatedAt,
          lastSyncedTimestamp: chat.lastSyncedTimestamp,
          providerLastModifiedTimestamp: chat.providerLastModifiedTimestamp,
        };
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);

    const embeddedCount = await MetadataRepository.countEmbeddings();

    sendResponse({
      success: true,
      data: {
        points: nodes,
        bounds: layout.bounds,
        embeddedCount,
        stats: {
          ...layout.stats,
          pointCount: nodes.length,
        },
      },
    });
  } catch (err) {
    log.error("[MetadataHandlers] getStarmapData failed", err);
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

export async function handleGetMetadataQueueItem(
  message: Extract<BackgroundRequest, { action: "getMetadataQueueItem" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const item = await getQueueItem(message.chatId);
    sendResponse({ success: true, data: item ?? null });
  } catch (err) {
    log.error("[MetadataHandlers] getMetadataQueueItem failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleResetMetadataQueueItem(
  message: Extract<BackgroundRequest, { action: "resetMetadataQueueItem" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await resetFailedQueueItem(message.chatId);
    sendResponse({ success: true });
  } catch (err) {
    log.error("[MetadataHandlers] resetMetadataQueueItem failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleResetAllFailedMetadata(
  _message: Extract<BackgroundRequest, { action: "resetAllFailedMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const reset = await resetAllFailed();
    sendResponse({ success: true, data: { reset } });
  } catch (err) {
    log.error("[MetadataHandlers] resetAllFailedMetadata failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleResetAllFailedEmbeddings(
  _message: Extract<BackgroundRequest, { action: "resetAllFailedEmbeddings" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const reset = await resetAllFailedEmbeddings();
    sendResponse({ success: true, data: { reset } });
  } catch (err) {
    log.error("[MetadataHandlers] resetAllFailedEmbeddings failed", err);
    sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function handleGetChatPreview(
  message: Extract<BackgroundRequest, { action: "getChatPreview" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const [metadata, messageCount, chat] = await Promise.all([
      MetadataRepository.get(message.chatId),
      ChatRepository.getChatMessageCount(message.chatId),
      ChatRepository.getChatRow(message.chatId),
    ]);
    sendResponse({
      success: true,
      data: {
        metadata,
        messageCount,
        createdAt: chat?.timestamp ?? 0,
        models: chat?.models ?? [],
      },
    });
  } catch (err) {
    log.error("[MetadataHandlers] getChatPreview failed", err);
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
