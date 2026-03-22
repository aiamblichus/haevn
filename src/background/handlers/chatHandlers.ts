// Chat management message handlers

import { CacheService } from "../../services/cacheService";
import { ChatService } from "../../services/chatService";
import { SyncService } from "../../services/syncService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";

export async function handleGetSyncedChatsMetadata(
  message: Extract<BackgroundRequest, { action: "getSyncedChatsMetadata" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const offset = message.offset ?? 0;
    const limit = message.limit ?? 50;
    const filterProvider = message.filterProvider ?? "all";
    const sortBy = message.sortBy ?? "lastSyncedTimestamp";
    const sortDirection = message.sortDirection ?? "desc";

    const result = await SyncService.getChatsMetadata(
      offset,
      limit,
      filterProvider,
      sortBy,
      sortDirection,
    );

    sendResponse({
      success: true,
      data: result.metadata,
      total: result.total,
    });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch metadata",
    });
  }
}

export async function handleGetSyncedChatContent(
  message: Extract<BackgroundRequest, { action: "getSyncedChatContent" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const chat = await SyncService.getChat(message.chatId);
    sendResponse({ success: true, data: chat });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to fetch chat",
    });
  }
}

export async function handleDeleteSyncedChats(
  message: Extract<BackgroundRequest, { action: "deleteSyncedChats" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const chatIds: string[] = message.chatIds || [];
    if (chatIds.length === 0) {
      sendResponse({ success: true });
      return;
    }
    await ChatService.deleteChatsWithCleanup(chatIds);
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to delete",
    });
  }
}

export async function handleExistsChat(
  message: Extract<BackgroundRequest, { action: "existsChat" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const id: string = message.chatId;
    if (!id) throw new Error("Missing chatId");
    const chat = await SyncService.getChat(id);
    sendResponse({ success: true, exists: !!chat });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Exists check failed",
    });
  }
}

export async function handleCheckForChanges(
  message: Extract<BackgroundRequest, { action: "checkForChanges" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await SyncService.performCheckForChanges(message.chatId);
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Check failed",
    });
  }
}

export async function handleGetProviderStats(
  message: Extract<BackgroundRequest, { action: "getProviderStats" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const providerName: string = message.providerName;
    if (!providerName) {
      throw new Error("Missing providerName");
    }
    const count = await CacheService.getProviderStats(providerName);
    sendResponse({ success: true, count });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get provider stats",
    });
  }
}

export async function handleCheckCurrentChatSynced(
  message: Extract<BackgroundRequest, { action: "checkCurrentChatSynced" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    // Accept platformName and conversationId directly from popup (already detected)
    const platformName: string | undefined = message.platformName;
    const conversationId: string | undefined = message.conversationId;
    const tabId: number | undefined = message.tabId;

    // Helper function to check and update cache
    const checkAndUpdateCache = async (
      source: string,
      sourceId: string,
    ): Promise<{ synced: boolean; chatId: string | null }> => {
      // Check cache first for instant response
      const cached = await CacheService.getSyncStatus(source, sourceId);
      if (cached) {
        // Cache hit - return immediately, but also verify in background
        verifyAndUpdateCache(source, sourceId).catch((err) => {
          log.error(
            `[checkCurrentChatSynced] Background verification failed for ${source}:${sourceId}:`,
            err,
          );
        });
        return cached;
      }

      // Cache miss - do full lookup and update cache
      return await verifyAndUpdateCache(source, sourceId);
    };

    // Helper function to verify sync status and update cache
    const verifyAndUpdateCache = async (
      source: string,
      sourceId: string,
    ): Promise<{ synced: boolean; chatId: string | null }> => {
      try {
        const matchingChat = await SyncService.getChatBySourceId(source, sourceId);
        const result = {
          synced: !!matchingChat,
          chatId: matchingChat?.id || null,
        };
        // Update cache
        await CacheService.setSyncStatus(source, sourceId, result.synced, result.chatId);
        return result;
      } catch (err) {
        log.error(`[checkCurrentChatSynced] DB query error for ${source}:${sourceId}:`, err);
        return { synced: false, chatId: null };
      }
    };

    // If platformName and conversationId are provided, use them directly (fast path)
    if (platformName && conversationId) {
      const result = await checkAndUpdateCache(platformName, conversationId);
      sendResponse({
        success: true,
        synced: result.synced,
        chatId: result.chatId,
      });
      return;
    }

    // Fallback: if platformName/conversationId not provided, use old method (for backward compatibility)
    if (!tabId) {
      sendResponse({ success: true, synced: false });
      return;
    }

    // Get conversation ID from content script
    try {
      const { pingTab } = await import("../utils/tabUtils");
      await pingTab(tabId);
      const convIdResponse = await chrome.tabs.sendMessage(tabId, {
        action: "getConversationId",
      });

      if (!convIdResponse?.conversationId) {
        sendResponse({ success: true, synced: false });
        return;
      }

      const convId = convIdResponse.conversationId;

      // Get platform info
      const platformResponse = await chrome.tabs.sendMessage(tabId, {
        action: "detectPlatform",
      });

      if (!platformResponse?.platform?.name) {
        sendResponse({ success: true, synced: false });
        return;
      }

      const platform = platformResponse.platform.name;

      // Use cache-aware check
      const result = await checkAndUpdateCache(platform, convId);
      sendResponse({
        success: true,
        synced: result.synced,
        chatId: result.chatId,
      });
    } catch (err) {
      // If content script is not available, assume not synced
      log.info("[checkCurrentChatSynced] Content script not available:", err);
      sendResponse({ success: true, synced: false });
    }
  } catch (err: unknown) {
    log.error("[checkCurrentChatSynced] Error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Check failed",
    });
  }
}
