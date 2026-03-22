/**
 * Poe GraphQL API Client
 * Provides structured access to Poe conversations using captured authentication tokens
 */

import { log } from "../../utils/logger";
import { RateLimiter } from "../../utils/rateLimit";
import {
  ChatHistoryListWithSearchPaginationResponse,
  ChatListPaginationResponse,
  ChatPageResponse,
  ChatsHistoryPageResponse,
  chatHistoryListWithSearchPaginationQuery,
  chatListPaginationQuery,
  chatPageQuery,
  chatsHistoryPageQuery,
  type Query,
} from "./model";

// Rate limit: 5 requests per second
const poeRateLimiter = new RateLimiter(5, 1000);

// ============================================================================
// Token Management
// ============================================================================

export interface PoeTokens {
  formkey?: string;
  tagId?: string;
  tchannel?: string;
  revision?: string;
  capturedAt: number;
}

const TOKEN_TTL = 60 * 60 * 1000; // 1 hour

/**
 * Get current tokens from chrome.storage if available and not expired
 */
async function getTokens(): Promise<PoeTokens | null> {
  try {
    const result = await chrome.storage.local.get("poeTokens");
    const tokens = result.poeTokens as PoeTokens | undefined;

    if (!tokens) {
      log.debug("[PoeApi] No tokens available in storage");
      return null;
    }

    const age = Date.now() - tokens.capturedAt;
    if (age > TOKEN_TTL) {
      log.warn("[PoeApi] Tokens expired", { ageMs: age });
      return null;
    }

    return tokens;
  } catch (err) {
    log.error("[PoeApi] Failed to retrieve tokens from storage", err);
    return null;
  }
}

/**
 * Check if we have valid tokens
 */
export async function hasValidTokens(): Promise<boolean> {
  const tokens = await getTokens();
  return tokens !== null;
}

/**
 * Build headers for GraphQL requests
 */
function buildHeaders(tokens: PoeTokens): Record<string, string> {
  if (!tokens.formkey || !tokens.tagId || !tokens.tchannel) {
    throw new Error("Incomplete Poe tokens. Missing: formkey, tagId, tchannel");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "poe-formkey": tokens.formkey,
    "poe-tag-id": tokens.tagId,
    "poe-tchannel": tokens.tchannel,
    poegraphql: "1",
  };

  if (tokens.revision) {
    headers["poe-revision"] = tokens.revision;
  }

  return headers;
}

/**
 * Execute a GraphQL query against Poe's API
 */
async function executeQuery<TVariables, TResponse>(
  body: Query<TVariables, TResponse>,
): Promise<TResponse> {
  const tokens = await getTokens();
  if (!tokens) {
    throw new Error("No valid Poe tokens available. Please refresh the Poe page.");
  }

  if (!tokens.formkey || !tokens.tagId || !tokens.tchannel) {
    const missing = [
      !tokens.formkey && "formkey",
      !tokens.tagId && "tagId",
      !tokens.tchannel && "tchannel",
    ].filter(Boolean);
    throw new Error(`Incomplete Poe tokens. Missing: ${missing.join(", ")}`);
  }

  log.debug(`[PoeApi] Executing ${body.queryName}`, { body });

  const response = await poeRateLimiter.schedule(() =>
    fetch("https://poe.com/api/gql_POST", {
      method: "POST",
      headers: buildHeaders(tokens),
      body: JSON.stringify(body),
    }),
  );

  if (!response.ok) {
    const text = await response.text();
    log.error(`[PoeApi] ${body.queryName} failed:`, text.substring(0, 500));
    throw new Error(`Poe GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  log.debug(`[PoeApi] Response for ${body.queryName}:`, data);

  if (data.errors) {
    log.error("[PoeApi] GraphQL errors:", data.errors);
    throw new Error(`GraphQL error: ${data.errors[0]?.message || "Unknown error"}`);
  }

  return data.data as TResponse;
}

export async function fetchHistory(): Promise<ChatsHistoryPageResponse> {
  const query = chatsHistoryPageQuery();
  return executeQuery(query);
}

export async function fetchPaginatedHistory(
  count: number,
  cursor: string,
): Promise<ChatHistoryListWithSearchPaginationResponse> {
  const query = chatHistoryListWithSearchPaginationQuery(count, cursor);
  return executeQuery(query);
}

export async function fetchChat(slug: string): Promise<ChatPageResponse> {
  const query = chatPageQuery(slug);
  return executeQuery(query);
}

export async function fetchPaginatedMessages(
  count: number,
  cursor: string,
  id: string,
): Promise<ChatListPaginationResponse> {
  const query = chatListPaginationQuery(count, cursor, id);
  return executeQuery(query);
}
