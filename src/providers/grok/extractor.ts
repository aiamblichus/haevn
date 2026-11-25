import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { RateLimiter } from "../../utils/rateLimit";
import { ExportOptions } from "../interfaces";
import { detectPlatform } from "../shared/platformDetector";
import type {
  GrokConversation,
  GrokConversationsResponse,
  GrokLoadResponsesResponse,
  GrokRawExtraction,
  GrokResponseNodesResponse,
} from "./model";

// Rate limit: 5 requests per second
const grokRateLimiter = new RateLimiter(5, 1000);

const GROK_BASE_URL = "https://grok.com";

// Platform Detection
export function isGrokPlatform(): boolean {
  return detectPlatform({
    hostnames: ["grok.com", "x.ai"],
  });
}

// Conversation ID Extraction from URL
export function extractGrokConversationIdFromUrl(url?: string): string | null {
  try {
    const urlStr = url || window.location.href;
    const urlObj = new URL(urlStr);
    // Pattern: https://grok.com/c/{conversationId}
    const match = urlObj.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  } catch (error) {
    log.error("[Grok Extractor] Error extracting conversation ID:", error);
    return null;
  }
}

/**
 * Fetch DAG structure from response-node endpoint
 */
async function fetchResponseNodes(conversationId: string): Promise<GrokResponseNodesResponse> {
  const apiUrl = `${GROK_BASE_URL}/rest/app-chat/conversations/${conversationId}/response-node?includeThreads=true`;

  const response = await grokRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
      },
      timeoutMs: 30000,
    }),
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch response nodes ${conversationId}: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as GrokResponseNodesResponse;

  log.debug("[Grok Extractor] Fetched response nodes:", {
    nodeCount: data.responseNodes?.length,
  });

  return data;
}

/**
 * Fetch conversation metadata
 */
async function fetchConversationMetadata(conversationId: string): Promise<GrokConversation> {
  const apiUrl = `${GROK_BASE_URL}/rest/app-chat/conversations/${conversationId}`;

  const response = await grokRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
      },
      timeoutMs: 30000,
    }),
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation metadata ${conversationId}: ${response.status} ${response.statusText}`,
    );
  }

  // The API returns the conversation data directly, not wrapped in { conversation: ... }
  const data = (await response.json()) as GrokConversation;

  log.debug("[Grok Extractor] Fetched conversation metadata:", {
    conversationId: data.conversationId,
    title: data.title,
  });

  return data;
}

/**
 * Fetch message content for specific response IDs
 */
async function fetchResponseContent(
  conversationId: string,
  responseIds: string[],
): Promise<GrokLoadResponsesResponse> {
  const apiUrl = `${GROK_BASE_URL}/rest/app-chat/conversations/${conversationId}/load-responses`;

  const response = await grokRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ responseIds }),
      timeoutMs: 60000, // Longer timeout for content fetch
    }),
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch response content for conversation ${conversationId}: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as GrokLoadResponsesResponse;
}

/**
 * Three-phase fetch: Get metadata, DAG structure, then message content
 */
async function fetchFullConversation(conversationId: string): Promise<GrokRawExtraction> {
  log.debug(`[Grok Extractor] Fetching conversation ${conversationId}`);

  // Phase 1: Get conversation metadata
  const conversation = await fetchConversationMetadata(conversationId);

  // Phase 2: Get DAG structure (response nodes)
  const responseNodesData = await fetchResponseNodes(conversationId);

  log.debug("[Grok Extractor] Phases 1-2 complete:", {
    conversationId: conversation.conversationId,
    nodeCount: responseNodesData.responseNodes.length,
  });

  // Phase 3: Fetch all message content
  const responseIds = responseNodesData.responseNodes.map((node) => node.responseId);
  const { responses } = await fetchResponseContent(conversationId, responseIds);

  log.debug("[Grok Extractor] Phase 3 complete:", {
    responseCount: responses.length,
  });

  const result = {
    conversation,
    responseNodes: responseNodesData.responseNodes,
    responses,
  };

  log.debug("[Grok Extractor] Full extraction complete:", {
    conversationId: result.conversation.conversationId,
    title: result.conversation.title,
    nodeCount: result.responseNodes.length,
    responseCount: result.responses.length,
  });

  return result;
}

/**
 * Extract data from current chat page
 */
export async function extractGrokConversationData(
  _options: ExportOptions = {},
): Promise<GrokRawExtraction> {
  if (!isGrokPlatform()) {
    throw new Error("Not on a Grok platform");
  }

  const conversationId = extractGrokConversationIdFromUrl();
  if (!conversationId) {
    throw new Error("Could not extract conversation ID from URL");
  }

  return fetchFullConversation(conversationId);
}

/** The most pages the chat list follows: 50 pages of 60 is 3,000 chats. */
const MAX_CHAT_LIST_PAGES = 50;

/**
 * One page of the chat list. The server caps a page at 60 chats whatever pageSize asks for, and
 * returns nextPageToken while more remain. A failed page throws: a partial list must not look whole.
 */
async function fetchChatListPage(pageToken?: string): Promise<GrokConversationsResponse> {
  const tokenParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
  const apiUrl = `${GROK_BASE_URL}/rest/app-chat/conversations?pageSize=100${tokenParam}`;

  const response = await grokRateLimiter.schedule(() =>
    fetchWithTimeout(apiUrl, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "*/*",
        "Content-Type": "application/json",
      },
      timeoutMs: 30000,
    }),
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch chat list: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GrokConversationsResponse;
}

/**
 * Get list of all chat IDs (for bulk sync), following the server's pages. Each id comes back once,
 * in the server's order. A repeated token, or the page cap, ends the walk with a warning and
 * returns what was collected.
 */
export async function extractGrokChatIds(): Promise<string[]> {
  log.debug("[Grok Extractor] Fetching chat list");

  const chatIds: string[] = [];
  const seenIds = new Set<string>();
  const followedTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 1; ; page++) {
    const data = await fetchChatListPage(pageToken);

    for (const conv of data.conversations) {
      if (!seenIds.has(conv.conversationId)) {
        seenIds.add(conv.conversationId);
        chatIds.push(conv.conversationId);
      }
    }

    const nextToken = data.nextPageToken;
    if (!nextToken) break;
    if (followedTokens.has(nextToken)) {
      log.warn(`[Grok Extractor] Chat list repeated a page token after ${page} pages; stopping`);
      break;
    }
    if (page >= MAX_CHAT_LIST_PAGES) {
      log.warn(
        `[Grok Extractor] Chat list hit the ${MAX_CHAT_LIST_PAGES}-page cap; stopping with ${chatIds.length} chats`,
      );
      break;
    }
    followedTokens.add(nextToken);
    pageToken = nextToken;
  }

  log.info(`[Grok Extractor] Found ${chatIds.length} conversations`);

  return chatIds;
}

/**
 * Get specific chat data by ID (for bulk sync)
 */
export async function fetchGrokChatData(
  chatId: string,
  _baseUrl?: string,
): Promise<GrokRawExtraction> {
  return fetchFullConversation(chatId);
}
