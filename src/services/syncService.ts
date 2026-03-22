/**
 * SyncService - Backwards-compatible facade
 *
 * Re-exports all public APIs from refactored modules:
 * - ChatRepository: CRUD operations
 * - SearchIndexManager: Index management
 * - SearchService: Search operations
 *
 * Consumer code continues using SyncService.methodName() unchanged.
 */

import { ChatRepository } from "./chatRepository";
import { SearchIndexManager } from "./searchIndexManager";
import { SearchService } from "./searchService";

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SyncService {
  // === CRUD Operations (delegated to ChatRepository) ===
  export const generateChatChecksum = ChatRepository.generateChatChecksum;
  export const saveChat = ChatRepository.saveChat;
  export const getChatsMetadata = ChatRepository.getChatsMetadata;
  export const getChat = ChatRepository.getChat;
  export const getChatBySourceId = ChatRepository.getChatBySourceId;
  export const existsChatBySourceId = ChatRepository.existsChatBySourceId;
  export const batchCheckExistingChats = ChatRepository.batchCheckExistingChats;
  export const deleteChats = ChatRepository.deleteChats;
  export const performCheckForChanges = ChatRepository.performCheckForChanges;

  // === Search Index Management (delegated to SearchIndexManager) ===
  export const init = SearchIndexManager.init;
  export const rebuildIndex = SearchIndexManager.rebuildIndex;
  export const addOrUpdateChatInIndex = SearchIndexManager.addOrUpdateChatInIndex;
  export const removeChatFromIndex = SearchIndexManager.removeChatFromIndex;
  export const startBulkSyncIndexing = SearchIndexManager.startBulkSyncIndexing;
  export const finishBulkSyncIndexing = SearchIndexManager.finishBulkSyncIndexing;

  // === Search Operations (delegated to SearchService) ===
  export const searchChats = SearchService.searchChats;
  export const getAllMatchesForChat = SearchService.getAllMatchesForChat;
  export const searchChatsStreaming = SearchService.searchChatsStreaming;
}
