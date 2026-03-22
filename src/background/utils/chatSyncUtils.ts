// Shared logic for transforming raw data to HAEVN.Chat and saving

import type { Chat } from "../../model/haevn_model";
import { hasTextContent } from "../../providers/claude/transformer";
import { CacheService } from "../../services/cacheService";
import { SyncService } from "../../services/syncService";
import type { AllProviderRawData } from "../../types/messaging";
import { log } from "../../utils/logger";
import { safeSendMessage } from "./messageUtils";
import { transformRawDataToHaevn } from "./platformTransform";

/**
 * Broadcasts a chatSynced event to notify UI components
 */
export function broadcastChatSynced(chat: Chat): void {
  safeSendMessage({
    action: "chatSynced",
    meta: {
      id: chat.id,
      source: chat.source,
      title: chat.title,
      lastSyncedTimestamp: chat.lastSyncedTimestamp,
      syncStatus: chat.syncStatus,
      providerLastModifiedTimestamp: chat.providerLastModifiedTimestamp,
      lastSyncAttemptMessage: chat.lastSyncAttemptMessage,
    },
  });
}

/**
 * Applies Open WebUI origin to chat params if needed
 */
function applyOpenWebUIOrigin(chat: Chat, platformName: string | undefined, origin?: string): void {
  if (platformName === "openwebui" && origin) {
    try {
      chat.params = {
        ...(chat.params || {}),
        openwebui_origin: origin,
      };
    } catch (_err) {
      // Ignore errors
    }
  }
}

/**
 * Transforms raw platform data to HAEVN.Chat format and saves it
 * @param rawData Raw platform-specific data
 * @param platformName Platform name from content script detection (optional)
 * @param hostname Hostname from URL (used as fallback)
 * @param origin Origin URL (for Open WebUI)
 * @param tabId Optional tab ID where the chat was extracted from (for media fetching)
 * @returns Array of saved chat IDs
 */
export async function transformAndSaveChat(
  rawData: AllProviderRawData,
  platformName: string | undefined,
  hostname: string,
  origin?: string,
  tabId?: number,
): Promise<string[]> {
  const haevnChats = await transformRawDataToHaevn(rawData, platformName, hostname, tabId);

  const savedIds: string[] = [];

  for (const haevnChat of haevnChats) {
    // Apply Open WebUI origin if needed
    applyOpenWebUIOrigin(haevnChat, platformName, origin);

    // Ensure chat has an ID (should be set by transformer, but check for safety)
    if (!haevnChat.id) {
      log.error("[chatSyncUtils] Chat missing ID, skipping:", haevnChat.source, haevnChat.sourceId);
      continue;
    }

    // For Claude chats, skip if there's no text content
    if (
      (platformName === "claude" || hostname.includes("claude.ai")) &&
      !hasTextContent(haevnChat as Parameters<typeof hasTextContent>[0])
    ) {
      log.info(`[chatSyncUtils] Skipping Claude chat ${haevnChat.id} - no text content`);
      continue;
    }

    // Check if this is a new chat (before saving)
    const existingChat = await SyncService.getChat(haevnChat.id);
    const isNewChat = !existingChat;

    // Save the chat
    await SyncService.saveChat(haevnChat, rawData);

    // Update sync status cache (mark as synced)
    if (haevnChat.source && haevnChat.sourceId) {
      try {
        await CacheService.setSyncStatus(
          haevnChat.source,
          haevnChat.sourceId,
          true,
          haevnChat.id ?? null,
        );
      } catch (err) {
        log.error("[chatSyncUtils] Failed to update sync status cache:", err);
      }
    }

    // Update provider stats cache (increment for new chats)
    if (isNewChat && platformName) {
      try {
        await CacheService.updateProviderStats(platformName, 1);
      } catch (err) {
        log.error("[chatSyncUtils] Failed to update provider stats:", err);
      }
    }

    // Broadcast the sync event
    broadcastChatSynced(haevnChat);

    savedIds.push(haevnChat.id);
  }

  return savedIds;
}
