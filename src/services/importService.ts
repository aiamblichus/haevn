// Import-specific business logic with full side effects orchestration

import type { Chat } from "../model/haevn_model";
import type { AllProviderRawData } from "../types/messaging";
import { fireAndForget } from "../utils/error_utils";
import { log } from "../utils/logger";
import { CacheService } from "./cacheService";
import { ChatService } from "./chatService";
import { SyncService } from "./syncService";

export interface SaveImportedChatOptions {
  skipIndexing?: boolean;
}

/**
 * Save an imported chat with full orchestration:
 * - Inject Open WebUI base URL if needed
 * - Check if chat is new (for stats update)
 * - Save to database
 * - Update provider stats for new chats
 * - Trigger thumbnail generation (fire-and-forget)
 * - Broadcast chat synced event
 */
async function saveImportedChat(
  chat: Chat,
  raw?: AllProviderRawData,
  options?: SaveImportedChatOptions,
): Promise<void> {
  if (!chat || typeof chat !== "object") {
    throw new Error("Missing chat payload");
  }
  if (!chat.id) {
    throw new Error("Chat missing id");
  }

  const skipIndexing = options?.skipIndexing ?? false;

  // For Open WebUI imports, automatically set the configured baseUrl if not already set
  if (chat.source?.toLowerCase().includes("openwebui")) {
    const params = chat.params as Record<string, unknown> | undefined;
    if (!params || !("openwebui_origin" in params)) {
      // Get the configured base URL from settings
      try {
        const { getOpenWebUIBaseUrl } = await import("./settingsService");
        const baseUrl = await getOpenWebUIBaseUrl();
        if (baseUrl) {
          chat.params = {
            ...(chat.params || {}),
            openwebui_origin: baseUrl,
          };
        }
      } catch (err: unknown) {
        log.warn("[ImportService] Failed to get Open WebUI base URL:", err);
      }
    }
  }

  // Check if this is a new chat (before saving)
  const existingChat = await SyncService.getChat(chat.id);
  const isNewChat = !existingChat;

  // Save chat
  await SyncService.saveChat(chat, raw, { skipIndexing });

  // Update provider stats cache (increment for new chats)
  if (isNewChat && chat.source) {
    const providerName = ChatService.extractProviderName(chat.source);
    if (providerName) {
      try {
        await CacheService.updateProviderStats(providerName, 1);
      } catch (err) {
        log.error("[ImportService] Failed to update provider stats:", err);
      }
    }
  }

  // Generate thumbnails (fire-and-forget)
  // Import lazily to avoid circular dependencies
  const { handleGenerateThumbnails } = await import("../background/handlers/galleryHandlers");
  fireAndForget(handleGenerateThumbnails(chat.id), `Generate thumbnails for ${chat.id}`);

  // Broadcast chat synced event
  const { broadcastChatSynced } = await import("../background/utils/chatSyncUtils");
  broadcastChatSynced(chat);
}

// Export as namespace
export const ImportService = {
  saveImportedChat,
};
