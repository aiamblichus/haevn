/**
 * SearchService - Search operations and text matching
 *
 * Provides full-text search functionality for chat content including:
 * - Basic search returning chat IDs
 * - All matches for a specific chat (for "Show more")
 * - Streaming search with progressive results
 * - Text snippet generation with highlighting
 *
 * This module handles the search operations while SearchIndexManager
 * handles the underlying Lunr.js index coordination.
 */

import { ensureOffscreenDocument } from "../background/utils/offscreenUtils";
import type { Chat, SearchResult } from "../model/haevn_model";
import type { SearchWorkerMessage, SearchWorkerResponse } from "../types/workerMessages";
import { fireAndForget } from "../utils/error_utils";
import { log } from "../utils/logger";
import { sendWorkerRequest } from "../utils/workerApi";
import { getDB } from "./db";
import { parseSearchQuery } from "./searchQuery";
import { buildSearchResultsForChat } from "./searchTextMatch";

// --- Worker Communication ---

/**
 * Send message to search worker via offscreen document.
 * The offscreen document creates and manages the worker, routing messages.
 */
async function _sendWorkerMessage(
  message: SearchWorkerMessage,
): Promise<SearchWorkerResponse | string[] | undefined> {
  const response = await sendWorkerRequest("search", message);

  // For search results, extract the results array
  if (response && response.type === "searchResult" && response.results) {
    return response.results;
  }

  // For other operations, return the full result
  // Fire-and-forget operations return undefined
  if (
    response &&
    (response.type === "initComplete" ||
      response.type === "addComplete" ||
      response.type === "removeComplete" ||
      response.type === "bulkComplete")
  ) {
    return response;
  }

  return undefined;
}

/**
 * Ensure worker is ready (no-op in new architecture - offscreen handles initialization).
 */
async function _ensureWorkerReady(): Promise<void> {
  // Ensure offscreen document exists
  await ensureOffscreenDocument();
  // Worker initialization happens lazily in offscreen document
}

// --- Helper Functions (Kept for getAllMatchesForChat / Single Chat expansion) ---

type ScopedSearchQuery = {
  idFilter?: string;
  textQuery: string;
};

function parseScopedSearchQuery(query: string): ScopedSearchQuery {
  const raw = (query || "").trim();
  if (!raw) return { textQuery: "" };

  let idFilter: string | undefined;
  const textQuery = raw
    .replace(/(^|\s)id:("[^"]+"|\S+)/i, (_match, prefix: string, value: string) => {
      const cleaned = value.replace(/^"|"$/g, "").trim();
      if (cleaned) idFilter = cleaned;
      return prefix ? " " : "";
    })
    .replace(/\s+/g, " ")
    .trim();

  return { idFilter, textQuery };
}

function chatIdMatchesFilter(chatId: string | undefined, idFilter: string | undefined): boolean {
  if (!idFilter) return true;
  if (!chatId) return false;
  return chatId.toLowerCase().startsWith(idFilter.toLowerCase());
}

async function findChatsByIdFilter(
  idFilter: string,
  options: { filterProvider?: string; limit?: number } = {},
): Promise<Chat[]> {
  const { filterProvider, limit = 1000 } = options;

  const chats = await getDB()
    .chats.where("deleted")
    .equals(0)
    .filter((chat) => {
      if (!chatIdMatchesFilter(chat.id, idFilter)) return false;
      if (filterProvider && filterProvider !== "all" && chat.source !== filterProvider)
        return false;
      return true;
    })
    .limit(limit)
    .toArray();

  return chats;
}

function buildIdSearchResult(chat: Chat): SearchResult {
  const safeChatId = chat.id || "";
  return {
    chatId: safeChatId,
    chatTitle: chat.title || "Untitled",
    source: chat.source,
    messageId: chat.currentId,
    messageContent: safeChatId,
    messageSnippet: `Matched chat ID: {{HIGHLIGHT}}${safeChatId}{{/HIGHLIGHT}}`,
    messageRole: "assistant",
    messageTimestamp: chat.timestamp,
    model: chat.models?.[0],
    params: chat.params,
  };
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SearchService {
  /**
   * Perform a Lunr search and return matching chat IDs.
   */
  export async function searchChats(query: string): Promise<string[]> {
    if (!query || !query.trim()) return [];
    try {
      const { idFilter, textQuery } = parseScopedSearchQuery(query);

      if (idFilter && !textQuery) {
        const chats = await findChatsByIdFilter(idFilter);
        return chats.map((chat) => chat.id).filter((id): id is string => !!id);
      }

      await _ensureWorkerReady();
      const requestId = `search_${Date.now()}_${Math.random()}`;
      // Basic search without hydration returns IDs (string[])
      const workerQuery = textQuery || query;
      const results = await _sendWorkerMessage({
        type: "search",
        query: workerQuery,
        requestId,
      });
      if (Array.isArray(results)) {
        const ids = results as string[];
        return idFilter ? ids.filter((id) => chatIdMatchesFilter(id, idFilter)) : ids;
      }
      return [];
    } catch (error) {
      log.error("Search failed", error);
      return [];
    }
  }

  /**
   * Get all matching messages for a specific chat and query.
   * Used for lazy loading when user expands "Show more" in search results.
   * TODO: Migrate this to worker as well in future pass
   */
  export async function getAllMatchesForChat(
    query: string,
    chatId: string,
  ): Promise<SearchResult[]> {
    const scoped = parseScopedSearchQuery(query);
    const q = scoped.textQuery;
    if (!query?.trim() || !chatId) return [];

    try {
      const chat = await getDB().chats.get(chatId);
      if (!chat) return [];

      if (scoped.idFilter && !chatIdMatchesFilter(chat.id, scoped.idFilter)) {
        return [];
      }

      if (!q) {
        return [buildIdSearchResult(chat)];
      }

      const parsed = parseSearchQuery(q);
      return buildSearchResultsForChat(chat, parsed);
    } catch (error) {
      log.error(`Failed to get all matches for chat ${chatId}`, error);
      return [];
    }
  }

  /**
   * Streaming search: processes chats in small batches and streams results via callback.
   * This provides much better perceived performance for large archives.
   *
   * @param query Search query string
   * @param options Streaming options including callbacks and limits
   * @returns Cancellation function
   */
  export function searchChatsStreaming(
    query: string,
    options: {
      onResults: (batch: SearchResult[]) => void;
      onComplete: (stats: {
        totalResults: number;
        chatsScanned: number;
        durationMs: number;
        wasLimited: boolean;
      }) => void;
      onError?: (error: Error) => void;
      streamBatchSize?: number;
      maxChatsToScan?: number;
      resultsPerChat?: number;
      filterProvider?: string;
      contextChars?: number;
    },
  ): { cancel: () => void } {
    const {
      onResults,
      onComplete,
      onError,
      maxChatsToScan = 1000,
      filterProvider,
      contextChars,
    } = options;

    const scoped = parseScopedSearchQuery(query);

    log.info(`[SearchService] searchChatsStreaming called:`, {
      query,
      textQuery: scoped.textQuery,
      idFilter: scoped.idFilter,
      maxChatsToScan,
      filterProvider,
    });

    let cancelled = false;
    const cancel = () => {
      log.debug(`[SearchService] Search cancelled for query: "${query}"`);
      cancelled = true;
    };

    (async () => {
      const startTime = performance.now();
      const requestId = `streaming_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      let totalResults = 0;
      let chatsScanned = 0; // Worker handles this, but we can track results count

      const finish = (wasLimited = false) => {
        if (cancelled) return;
        const durationMs = performance.now() - startTime;
        log.info(`[SearchService] Search finished:`, {
          query,
          totalResults,
          durationMs: durationMs.toFixed(2),
        });
        onComplete({
          totalResults,
          chatsScanned,
          durationMs,
          wasLimited,
        });
      };

      // ID-only mode: return matching chat(s) directly without full-text matching.
      if (scoped.idFilter && !scoped.textQuery) {
        fireAndForget(
          (async () => {
            try {
              const chats = await findChatsByIdFilter(scoped.idFilter as string, {
                filterProvider,
                limit: maxChatsToScan,
              });
              if (cancelled) return;

              const results = chats
                .filter((chat) => !!chat.id)
                .map((chat) => buildIdSearchResult(chat));
              totalResults = results.length;
              chatsScanned = results.length;

              if (results.length > 0) {
                onResults(results);
              }

              finish(chats.length >= maxChatsToScan);
            } catch (err) {
              log.error(`[SearchService] Error during ID-only search:`, {
                query,
                error: err instanceof Error ? err.message : String(err),
              });
              if (onError) onError(err instanceof Error ? err : new Error(String(err)));
            }
          })(),
          "Streaming ID-only search operation",
        );
        return;
      }

      // Use fireAndForget to start the search without blocking
      fireAndForget(
        sendWorkerRequest(
          "search",
          {
            type: "search",
            query: scoped.textQuery || query,
            requestId,
            maxResults: maxChatsToScan,
            filterProvider,
            contextChars,
            // @ts-expect-error - 'hydrate' is new, typescript might not know it yet if we didn't update types
            hydrate: true,
          },
          {
            onProgress: (chunk) => {
              if (cancelled) return;

              // The worker now returns SearchResult[] when hydrate: true
              let results = chunk.results as SearchResult[];

              if (scoped.idFilter) {
                results = results.filter((result) =>
                  chatIdMatchesFilter(result.chatId, scoped.idFilter),
                );
              }

              if (results.length > 0) {
                totalResults += results.length;
                chatsScanned += results.length; // Approximation
                onResults(results);
              }

              if (chunk.done) {
                finish();
              }
            },
            timeout: 60000,
          },
        ).catch((err) => {
          log.error(`[SearchService] Error during search:`, {
            query,
            error: err instanceof Error ? err.message : String(err),
          });
          if (onError) onError(err instanceof Error ? err : new Error(String(err)));
        }),
        "Streaming search operation",
      );
    })();

    return { cancel };
  }
}
