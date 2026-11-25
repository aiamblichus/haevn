// Search message handlers

import type { SearchResult } from "../../model/haevn_model";
import * as MetadataRepository from "../../services/metadataRepository";
import { SearchQueryError } from "../../services/searchQuery";
import { SyncService } from "../../services/syncService";
import type { BackgroundEvent, BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";
import { charsOf, errorKind } from "../../utils/logShape";
import { safeSendMessage } from "../utils/messageUtils";

// Track active streaming searches for cancellation
const activeStreamingSearches = new Map<string, { cancel: () => void; query: string }>();

// Helper to broadcast events to all UI components
function broadcastEvent(event: BackgroundEvent): void {
  safeSendMessage(event);
}

export async function handleSearchChats(
  message: Extract<BackgroundRequest, { action: "searchChats" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const query: string = (message.query || "").trim();
    const filterProvider = message.filterProvider;
    // A search query is the person's words: the log names its length, not it (HVN-157).
    log.info(`[SearchHandler] handleSearchChats called with query: ${charsOf(query)}`);
    if (!query) {
      log.debug("[SearchHandler] Empty query, returning empty results");
      sendResponse({ success: true, results: [] });
      return;
    }

    // Use streaming search and collect all results for backward compatibility
    const allResults: SearchResult[] = [];

    log.debug("[SearchHandler] Starting streaming search (non-streaming mode)", {
      query: charsOf(query),
      filterProvider,
      streamBatchSize: 50,
      maxChatsToScan: 1000,
      resultsPerChat: 4,
    });

    SyncService.searchChatsStreaming(query, {
      streamBatchSize: 50, // Larger batches for non-streaming use case
      maxChatsToScan: 1000,
      resultsPerChat: 4, // Fetch 4 per chat (show 3, button appears if 4+)
      filterProvider,
      onResults: (batch) => {
        log.debug(`[SearchHandler] Received batch in handleSearchChats:`, {
          batchSize: batch.length,
          totalSoFar: allResults.length,
        });
        allResults.push(...batch);
      },
      onComplete: (stats) => {
        log.info(`[SearchHandler] Search complete (handleSearchChats):`, {
          query: charsOf(query),
          totalResults: allResults.length,
          indexRebuilding: stats.indexRebuilding,
          indexIncomplete: stats.indexIncomplete,
        });
        sendResponse({
          success: true,
          results: allResults,
          wasLimited: stats.wasLimited,
          ...(stats.indexRebuilding ? { indexRebuilding: stats.indexRebuilding } : {}),
          ...(stats.indexIncomplete ? { indexIncomplete: stats.indexIncomplete } : {}),
        });
      },
      onError: (error) => {
        log.error(`[SearchHandler] Search error (handleSearchChats):`, {
          query: charsOf(query),
          error: errorKind(error),
        });
        sendResponse({
          success: false,
          error: error.message || "Search failed",
        });
      },
    });

    // Note: This handler uses streaming internally but collects all results
    // before responding. For true streaming, use searchChatsStreaming action.
    // We return true to keep the channel open for async response.
    return;
  } catch (err: unknown) {
    log.error("[SearchHandler] Exception in handleSearchChats:", errorKind(err));
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Search failed",
    });
  }
}

export async function handleSearchChatsStreaming(
  message: Extract<BackgroundRequest, { action: "searchChatsStreaming" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const query: string = (message.query || "").trim();
    const filterProvider = message.filterProvider;
    log.info(`[SearchHandler] handleSearchChatsStreaming called:`, {
      query: charsOf(query),
      filterProvider,
      streamBatchSize: message.streamBatchSize,
      maxChatsToScan: message.maxChatsToScan,
      resultsPerChat: message.resultsPerChat,
    });

    if (!query) {
      log.warn("[SearchHandler] Empty query provided to handleSearchChatsStreaming");
      sendResponse({ success: false, error: "Query is required" });
      return;
    }

    // Cancel any existing searches (only one search should be active at a time)
    const cancelledCount = activeStreamingSearches.size;
    if (cancelledCount > 0) {
      log.info(`[SearchHandler] Cancelling ${cancelledCount} existing search(es)`);
      for (const [existingQuery, controller] of activeStreamingSearches.entries()) {
        log.debug(`[SearchHandler] Cancelling search for query: ${charsOf(existingQuery)}`);
        controller.cancel();
        activeStreamingSearches.delete(existingQuery);
      }
    }

    // Broadcast start event
    log.debug(`[SearchHandler] Broadcasting searchStreamingStarted event`);
    broadcastEvent({
      action: "searchStreamingStarted",
      query,
      filterProvider,
    });

    // Start streaming search
    log.debug(`[SearchHandler] Starting SyncService.searchChatsStreaming`);
    const controller = SyncService.searchChatsStreaming(query, {
      streamBatchSize: message.streamBatchSize || 5,
      maxChatsToScan: message.maxChatsToScan || 1000,
      resultsPerChat: message.resultsPerChat || 3,
      filterProvider,
      onResults: (batch) => {
        log.debug(`[SearchHandler] onResults callback called:`, {
          query: charsOf(query),
          batchSize: batch.length,
          results: batch.map((r) => ({
            chatId: r.chatId,
            messageId: r.messageId,
            role: r.messageRole,
          })),
        });
        // Enrich with metadata titles, then broadcast
        const uniqueChatIds = [...new Set(batch.map((r) => r.chatId))];
        MetadataRepository.getMany(uniqueChatIds)
          .then((metaMap) => {
            const enriched = batch.map((r) => {
              const meta = metaMap.get(r.chatId);
              return meta?.title ? { ...r, metaTitle: meta.title } : r;
            });
            broadcastEvent({
              action: "searchStreamingResults",
              query,
              filterProvider,
              results: enriched,
            });
          })
          .catch(() => {
            broadcastEvent({
              action: "searchStreamingResults",
              query,
              filterProvider,
              results: batch,
            });
          });
      },
      onComplete: (stats) => {
        log.info(`[SearchHandler] onComplete callback called:`, {
          query: charsOf(query),
          ...stats,
        });
        // Broadcast completion
        broadcastEvent({
          action: "searchStreamingComplete",
          query,
          filterProvider,
          ...stats,
        });
        // Clean up
        activeStreamingSearches.delete(query);
        log.debug(`[SearchHandler] Removed search from activeStreamingSearches`);
      },
      onError: (error) => {
        log.error(`[SearchHandler] onError callback called:`, {
          query: charsOf(query),
          error: errorKind(error),
        });
        // Broadcast error
        broadcastEvent({
          action: "searchStreamingFailed",
          query,
          filterProvider,
          error: error.message,
          // A query with nothing to look for is not a failure of the search: the archive says it
          // as a hint, since a search as you type meets it on the way to a word.
          ...(error instanceof SearchQueryError ? { queryProblem: true } : {}),
        });
        // Clean up
        activeStreamingSearches.delete(query);
        log.debug(`[SearchHandler] Removed search from activeStreamingSearches after error`);
      },
    });

    // Store controller for cancellation
    activeStreamingSearches.set(query, { cancel: controller.cancel, query });
    log.debug(
      `[SearchHandler] Stored search controller, active searches: ${activeStreamingSearches.size}`,
    );

    // Respond immediately (search runs asynchronously)
    log.debug(`[SearchHandler] Sending immediate response to caller`);
    sendResponse({ success: true, message: "Streaming search started" });
  } catch (err: unknown) {
    // Not the message and not the stack (it opens with the message): a search error can quote the query.
    log.error("[SearchHandler] Exception in handleSearchChatsStreaming:", {
      error: errorKind(err),
    });
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to start streaming search",
    });
  }
}

export async function handleCancelSearchStreaming(
  _message: Extract<BackgroundRequest, { action: "cancelSearchStreaming" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    // Cancel all active searches
    let cancelledCount = 0;
    for (const [query, controller] of activeStreamingSearches.entries()) {
      controller.cancel();
      activeStreamingSearches.delete(query);
      cancelledCount++;
    }
    if (cancelledCount > 0) {
      sendResponse({
        success: true,
        message: `Cancelled ${cancelledCount} search(es)`,
      });
    } else {
      sendResponse({ success: true, message: "No active searches to cancel" });
    }
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to cancel search",
    });
  }
}

export async function handleGetAllMatchesForChat(
  message: Extract<BackgroundRequest, { action: "getAllMatchesForChat" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const query: string = (message.query || "").trim();
    const chatId: string = message.chatId || "";
    if (!query || !chatId) {
      sendResponse({ success: false, error: "Query and chatId are required" });
      return;
    }

    const results = await SyncService.getAllMatchesForChat(query, chatId);
    sendResponse({ success: true, results });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get all matches for chat",
    });
  }
}

export async function handleRebuildIndex(
  _message: Extract<BackgroundRequest, { action: "rebuildIndex" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    log.info("[SearchHandler] handleRebuildIndex called");
    await SyncService.rebuildIndex();
    sendResponse({ success: true, message: "Index rebuild started" });
  } catch (err: unknown) {
    log.error("[SearchHandler] Exception in handleRebuildIndex:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to rebuild index",
    });
  }
}
