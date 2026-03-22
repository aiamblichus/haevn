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
import type {
  Chat,
  ChatMessage,
  SearchResult,
  SystemPromptPart,
  TextPart,
  ThinkingPart,
  UserPromptPart,
} from "../model/haevn_model";
import type { SearchWorkerMessage, SearchWorkerResponse } from "../types/workerMessages";
import { fireAndForget } from "../utils/error_utils";
import { log } from "../utils/logger";
import { sendWorkerRequest } from "../utils/workerApi";
import { getDB } from "./db";

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

/**
 * Parsed search query with phrase and term information preserved.
 */
type ParsedQuery = {
  phrases: string[];
  terms: string[];
};

/**
 * Parse a search query into phrases (from "quoted" segments) and individual terms.
 * Strips Lunr operators and de-duplicates terms.
 */
function parseSearchQuery(query: string): ParsedQuery {
  const phrases: string[] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const remainderParts: string[] = [];

  match = quoteRegex.exec(query);
  while (match !== null) {
    const pre = query.slice(lastIndex, match.index).trim();
    if (pre) remainderParts.push(pre);
    const phrase = match[1].trim();
    if (phrase) phrases.push(phrase);
    lastIndex = quoteRegex.lastIndex;
    match = quoteRegex.exec(query);
  }
  const tail = query.slice(lastIndex).trim();
  if (tail) remainderParts.push(tail);

  const cleaned = remainderParts.join(" ").replace(/[+\-~*^:"()]/g, " ");
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const t of cleaned.split(/\s+/)) {
    const trimmed = t.trim();
    if (trimmed && !seen.has(trimmed.toLowerCase())) {
      seen.add(trimmed.toLowerCase());
      terms.push(trimmed);
    }
  }

  return { phrases, terms };
}

/**
 * Check whether text matches all phrases and all terms (AND semantics).
 */
function messageMatches(text: string, parsed: ParsedQuery): boolean {
  const hay = text.toLowerCase();
  for (const p of parsed.phrases) {
    if (!hay.includes(p.toLowerCase())) return false;
  }
  for (const t of parsed.terms) {
    if (!hay.includes(t.toLowerCase())) return false;
  }
  return parsed.phrases.length > 0 || parsed.terms.length > 0;
}

/**
 * Internal type for match candidates.
 */
type MatchCandidate = {
  chatMessage: ChatMessage;
  role: "user" | "assistant";
  text: string;
  matchIndex: number;
  matchedLength: number;
  timestampMs?: number;
};

/**
 * Flatten a ChatMessage into separate user and assistant text strings.
 * Extracts timestamps for each role.
 */
function flattenChatMessageText(cm: ChatMessage): {
  userText: string;
  assistantText: string;
  userFirstTimestamp?: number;
  assistantFirstTimestamp?: number;
} {
  const userTextParts: string[] = [];
  const assistantTextParts: string[] = [];
  let userFirstTimestamp: number | undefined;
  let assistantFirstTimestamp: number | undefined;

  const arr = cm?.message || [];
  for (const mm of arr) {
    if (mm.kind === "request") {
      const req = mm;
      for (const part of req.parts) {
        const partAny = part as { part_kind?: string };
        if (partAny.part_kind === "user-prompt") {
          const up = part as UserPromptPart;
          if (typeof up.content === "string") userTextParts.push(up.content);
          else if (Array.isArray(up.content)) {
            for (const c of up.content) if (typeof c === "string") userTextParts.push(c);
          }
          if (!userFirstTimestamp) {
            try {
              userFirstTimestamp = up.timestamp ? new Date(up.timestamp).getTime() : undefined;
            } catch {
              // ignore
            }
          }
        } else if (partAny.part_kind === "system-prompt") {
          const sp = part as SystemPromptPart;
          if (typeof sp.content === "string") {
            userTextParts.push(sp.content);
          }
        }
      }
    } else if (mm.kind === "response") {
      const res = mm;
      if (!assistantFirstTimestamp) {
        try {
          assistantFirstTimestamp = res.timestamp ? new Date(res.timestamp).getTime() : undefined;
        } catch {
          // ignore
        }
      }
      for (const part of res.parts) {
        const partAny = part as { part_kind?: string };
        const pk = partAny.part_kind;
        if (pk === "text") assistantTextParts.push((part as TextPart).content);
        else if (pk === "thinking") assistantTextParts.push((part as ThinkingPart).content);
      }
    }
  }

  return {
    userText: userTextParts.join(" ").trim(),
    assistantText: assistantTextParts.join(" ").trim(),
    userFirstTimestamp,
    assistantFirstTimestamp,
  };
}

/**
 * Locate the best match position in text for snippet generation.
 * Prefers phrase positions, falls back to first individual term.
 */
function locateMatch(text: string, parsed: ParsedQuery): { index: number; length: number } | null {
  if (!text) return null;
  const hay = text.toLowerCase();

  // Prefer phrase match positions for snippet centering
  for (const p of parsed.phrases) {
    const idx = hay.indexOf(p.toLowerCase());
    if (idx >= 0) return { index: idx, length: p.length };
  }

  // Fallback: find the earliest occurrence of any term
  let bestIdx = -1;
  let bestLen = 0;
  for (const t of parsed.terms) {
    const needle = t.toLowerCase();
    const i = hay.indexOf(needle);
    if (i >= 0 && (bestIdx === -1 || i < bestIdx)) {
      bestIdx = i;
      bestLen = needle.length;
    }
  }
  return bestIdx >= 0 ? { index: bestIdx, length: bestLen } : null;
}

/**
 * Escape special regex characters.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a snippet around a match with highlighting markers.
 * Returns text with {{HIGHLIGHT}}...{{/HIGHLIGHT}} markers.
 */
function buildSnippet(
  text: string,
  index: number,
  len: number,
  terms: string[],
  radius = 90,
): string {
  if (!text) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + len + radius);
  let snippet = text.slice(start, end);
  // Replace newlines to keep snippets compact
  snippet = snippet.replace(/\s+/g, " ").trim(); // Corrected: escaped backslash for regex
  if (terms.length > 0) {
    const pattern = terms
      .map((t) => escapeRegExp(t))
      .filter((t) => !!t)
      .join("|");
    if (pattern) {
      const re = new RegExp(`(${pattern})`, "gi");
      snippet = snippet.replace(re, "{{HIGHLIGHT}}$1{{/HIGHLIGHT}}");
    }
  }
  return snippet;
}

/**
 * Find all message-level matches within a chat for given parsed query.
 * Uses AND semantics: all phrases and all terms must be present.
 */
function findAllMatchingMessages(chat: Chat, parsed: ParsedQuery): MatchCandidate[] {
  const messages = Object.values(chat.messages || {});
  const out: MatchCandidate[] = [];

  for (const cm of messages) {
    const { userText, userFirstTimestamp, assistantText, assistantFirstTimestamp } =
      flattenChatMessageText(cm);

    if (userText && messageMatches(userText, parsed)) {
      const m = locateMatch(userText, parsed);
      if (m) {
        out.push({
          chatMessage: cm,
          role: "user",
          text: userText,
          matchIndex: m.index,
          matchedLength: m.length,
          timestampMs: cm.timestamp || userFirstTimestamp,
        });
      }
    }

    if (assistantText && messageMatches(assistantText, parsed)) {
      const m = locateMatch(assistantText, parsed);
      if (m) {
        out.push({
          chatMessage: cm,
          role: "assistant",
          text: assistantText,
          matchIndex: m.index,
          matchedLength: m.length,
          timestampMs: cm.timestamp || assistantFirstTimestamp,
        });
      }
    }
  }

  return out;
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace SearchService {
  /**
   * Perform a Lunr search and return matching chat IDs.
   */
  export async function searchChats(query: string): Promise<string[]> {
    if (!query || !query.trim()) return [];
    try {
      await _ensureWorkerReady();
      const requestId = `search_${Date.now()}_${Math.random()}`;
      // Basic search without hydration returns IDs (string[])
      const results = await _sendWorkerMessage({
        type: "search",
        query,
        requestId,
      });
      if (Array.isArray(results)) {
        return results as string[];
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
    const q = (query || "").trim();
    if (!q || !chatId) return [];

    try {
      const chat = await getDB().chats.get(chatId);
      if (!chat) return [];

      const parsed = parseSearchQuery(q);
      const matches = findAllMatchingMessages(chat, parsed);

      if (matches.length === 0) return [];

      // Sort by timestamp (ascending) to keep context natural
      matches.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

      // Collect all highlight terms: phrase words + individual terms
      const highlightTerms = [...parsed.phrases.flatMap((p) => p.split(/\s+/)), ...parsed.terms];

      const results: SearchResult[] = [];
      for (const m of matches) {
        const snippet = buildSnippet(m.text, m.matchIndex, m.matchedLength, highlightTerms);
        if (!chat.id) {
          continue; // Skip chats without IDs
        }
        results.push({
          chatId: chat.id,
          chatTitle: chat.title,
          source: chat.source,
          messageId: m.chatMessage.id,
          messageContent: m.text,
          messageSnippet: snippet,
          messageRole: m.role,
          messageTimestamp: m.timestampMs,
        });
      }

      return results;
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
    },
  ): { cancel: () => void } {
    const { onResults, onComplete, onError, maxChatsToScan = 1000, filterProvider } = options;

    log.info(`[SearchService] searchChatsStreaming called:`, {
      query,
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

      const finish = () => {
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
          wasLimited: false,
        });
      };

      // Use fireAndForget to start the search without blocking
      fireAndForget(
        sendWorkerRequest(
          "search",
          {
            type: "search",
            query,
            requestId,
            maxResults: maxChatsToScan,
            filterProvider,
            // @ts-expect-error - 'hydrate' is new, typescript might not know it yet if we didn't update types
            hydrate: true,
          },
          {
            onProgress: (chunk) => {
              if (cancelled) return;

              // The worker now returns SearchResult[] when hydrate: true
              const results = chunk.results as SearchResult[];

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
