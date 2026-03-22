import { arrayBufferToBase64 } from "../../utils/binary_utils";
import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { RateLimiter } from "../../utils/rateLimit";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import type {
  ChatGPTRawExtraction,
  ChatList,
  OpenAIConversation,
  OpenAIConversationNode,
} from "./model";

// Rate limit: 5 requests per second
const chatgptRateLimiter = new RateLimiter(5, 1000);

// Platform detection
export function isChatGPTPlatform(): boolean {
  return detectPlatform({
    hostnames: ["chat.openai.com", "chatgpt.com"],
  });
}

// Conversation ID from URL (/c/<id>)
export function extractChatGPTConversationId(): string {
  const pathname = window.location.pathname;
  try {
    const match = pathname.match(/\/c\/([^/?]+)/);
    return match ? match[1] : generateFallbackId("chatgpt");
  } catch (e) {
    log.error("[ChatGPT] Failed to parse conversation id:", e);
    return generateFallbackId("chatgpt");
  }
}

// Get accessToken from storage (captured by listener)
// Rejects tokens older than 45 minutes to avoid stale-token 401s.
const TOKEN_TTL_MS = 45 * 60 * 1000;

async function getAccessTokenFromStorage(): Promise<string | null> {
  try {
    const result = await chrome.storage.local.get("chatgptAuthTokens");
    const tokens = result.chatgptAuthTokens as
      | { accessToken?: string; capturedAt?: number }
      | undefined;
    if (!tokens?.accessToken) return null;
    if (tokens.capturedAt && Date.now() - tokens.capturedAt > TOKEN_TTL_MS) {
      log.debug("[ChatGPT Extractor] Cached access token is stale, will re-fetch");
      return null;
    }
    return tokens.accessToken;
  } catch (error) {
    log.debug("[ChatGPT Extractor] Failed to read accessToken from storage:", error);
    return null;
  }
}

// Fetch and store access token from auth session endpoint
async function fetchAndStoreAccessToken(): Promise<string | null> {
  const origins = ["https://chatgpt.com", "https://chat.openai.com"];
  for (const origin of origins) {
    try {
      const resp = await chatgptRateLimiter.schedule(() =>
        fetchWithTimeout(`${origin}/api/auth/session`, {
          credentials: "include",
          timeoutMs: 30000,
        }),
      );
      if (!resp.ok) continue;
      const json = await resp.json();
      const accessToken = json?.accessToken;

      if (accessToken && typeof accessToken === "string") {
        // Store it for future use
        await chrome.storage.local.set({
          chatgptAuthTokens: {
            accessToken,
            capturedAt: Date.now(),
          },
        });
        return accessToken;
      }
    } catch (err: unknown) {
      log.warn(`[ChatGPT] Failed to fetch access token from ${origin}:`, err);
    }
  }
  return null;
}

// Get OAuth-like session access token (try storage first, fallback to fetch)
export async function getAccessToken(): Promise<string> {
  // Try storage first (captured by listener)
  let token = await getAccessTokenFromStorage();
  if (token) return token;

  // Fallback to fetching and storing
  token = await fetchAndStoreAccessToken();
  if (token) return token;

  throw new Error("Unable to obtain ChatGPT access token. Please ensure you are logged in.");
}

// Base URL resolver (prefer chatgpt.com if present)
function getBaseUrl(): string {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname.includes("chatgpt.com")) return "https://chatgpt.com";
  return "https://chat.openai.com";
}

// Fetch list of chats with pagination
async function fetchChatList(accessToken: string, offset = 0, limit = 100): Promise<ChatList> {
  const base = getBaseUrl();
  const url = `${base}/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated&is_archived=false`;
  const resp = await chatgptRateLimiter.schedule(() =>
    fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 30000,
    }),
  );
  if (!resp.ok)
    throw new Error(`Failed to fetch ChatGPT chat list: ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as ChatList;
}

// Public: Extract all ChatGPT chat IDs
export async function extractChatGPTChatIds(): Promise<string[]> {
  let accessToken = await getAccessToken();
  const all: string[] = [];
  let offset = 0;
  const limit = 100;
  let tokenRefreshed = false;
  while (true) {
    try {
      const page = await fetchChatList(accessToken, offset, limit);
      const items = page?.items || [];
      if (items.length === 0) break;
      for (const it of items) if (it?.id) all.push(it.id);
      if (items.length < limit) break;
      offset += limit;
    } catch (err) {
      // On 401, force-clear cached token and retry once with a fresh one
      if (!tokenRefreshed && err instanceof Error && err.message.includes("401")) {
        log.info("[ChatGPT] Got 401 fetching chat list — refreshing access token and retrying");
        await chrome.storage.local.remove("chatgptAuthTokens");
        const freshToken = await fetchAndStoreAccessToken();
        if (!freshToken) throw err;
        accessToken = freshToken;
        tokenRefreshed = true;
        // retry same page (don't advance offset)
        continue;
      }
      throw err;
    }
  }
  return all;
}

// Fetch a single conversation JSON
export async function fetchConversation(
  accessToken: string,
  conversationId: string,
): Promise<OpenAIConversation> {
  const base = getBaseUrl();
  const url = `${base}/backend-api/conversation/${conversationId}`;
  const resp = await chatgptRateLimiter.schedule(() =>
    fetchWithTimeout(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 30000,
    }),
  );
  if (!resp.ok)
    throw new Error(`Failed to fetch ChatGPT conversation: ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as OpenAIConversation;
}

// Asset downloading
async function downloadAsset(
  accessToken: string,
  assetPointer: string,
  conversationId: string,
): Promise<{
  dataBase64: string;
  contentType: string;
  filename?: string;
} | null> {
  try {
    const base = getBaseUrl();
    let url: string | null = null;
    if (assetPointer.startsWith("sediment://")) {
      // sediment://file_... -> .../files/download/file_...?conversation_id=...&inline=false
      const fileId = assetPointer.replace("sediment://", "");
      url = `${base}/backend-api/files/download/${encodeURIComponent(
        fileId,
      )}?conversation_id=${encodeURIComponent(conversationId)}&inline=false`;
    } else if (assetPointer.startsWith("file-service://")) {
      // file-service://file-... -> .../files/download/file-...?post_id=&inline=false
      const fileId = assetPointer.replace("file-service://", "");
      url = `${base}/backend-api/files/download/${encodeURIComponent(
        fileId,
      )}?post_id=&inline=false`;
    }

    if (!url) return null;
    const resp = await chatgptRateLimiter.schedule(() =>
      fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeoutMs: 30000,
      }),
    );
    if (!resp.ok) {
      log.warn(
        "[ChatGPT] Failed to initiate asset download",
        assetPointer,
        resp.status,
        resp.statusText,
      );
      return null;
    }
    // The API returns JSON with a temporary download_url
    let downloadUrl: string | null = null;
    let fileName: string | undefined;
    let declaredMime: string | undefined;
    try {
      const meta = await resp.json();
      downloadUrl = meta?.download_url || null;
      fileName = meta?.file_name || undefined;
      declaredMime = meta?.mime_type || undefined;
    } catch (_e) {
      log.warn("[ChatGPT] Asset meta JSON parse failed; falling back to raw body");
    }

    if (!downloadUrl) {
      // Fallback: treat the first response as the file (legacy behavior)
      const contentType =
        resp.headers.get("content-type") || declaredMime || "application/octet-stream";
      const buf = await resp.arrayBuffer();
      return {
        dataBase64: arrayBufferToBase64(buf),
        contentType,
        filename: fileName,
      };
    }

    const second = await chatgptRateLimiter.schedule(() =>
      fetchWithTimeout(downloadUrl, { timeoutMs: 30000 }),
    );
    if (!second.ok) {
      log.warn("[ChatGPT] Second-stage asset download failed", second.status, second.statusText);
      return null;
    }
    const contentType =
      second.headers.get("content-type") ||
      declaredMime ||
      (fileName ? guessMimeFromFilename(fileName) : "application/octet-stream");
    const buf = await second.arrayBuffer();
    return {
      dataBase64: arrayBufferToBase64(buf),
      contentType,
      filename: fileName,
    };
  } catch (e) {
    log.warn("[ChatGPT] Asset download error for", assetPointer, e);
    return null;
  }
}

function guessMimeFromFilename(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".svg")) return "image/svg+xml";
  if (n.endsWith(".bmp")) return "image/bmp";
  return "application/octet-stream";
}

// Types moved to model.ts

// Find all asset pointers in conversation mapping
function collectAssetPointers(conv: OpenAIConversation): {
  pointers: string[];
  byNode: Record<string, string[]>;
} {
  const pointersSet = new Set<string>();
  const byNode: Record<string, string[]> = {};
  Object.values(conv.mapping || {}).forEach((node: OpenAIConversationNode) => {
    const msg = node.message;
    if (!msg || !msg.content) return;
    const content = msg.content as { parts?: unknown[] } | undefined;
    const parts = (content?.parts || []) as Array<{
      content_type?: string;
      asset_pointer?: string;
    }>;
    for (const p of parts) {
      if (
        typeof p === "object" &&
        p?.content_type === "image_asset_pointer" &&
        typeof p.asset_pointer === "string"
      ) {
        pointersSet.add(p.asset_pointer);
        if (!byNode[node.id]) byNode[node.id] = [];
        byNode[node.id].push(p.asset_pointer);
      }
    }
  });
  return { pointers: Array.from(pointersSet), byNode };
}

// Fetch conversation by ID directly (for bulk sync - no navigation needed)
export async function fetchChatGPTConversation(
  accessToken: string,
  conversationId: string,
): Promise<ChatGPTRawExtraction> {
  const conversation = await fetchConversation(accessToken, conversationId);

  const { pointers } = collectAssetPointers(conversation);
  const assets: ChatGPTAssetsMap = {};
  // Use the correct conversation id for asset download (conversation_id fallback)
  const convIdForAssets =
    ("conversation_id" in conversation && typeof conversation.conversation_id === "string"
      ? conversation.conversation_id
      : null) ||
    ("id" in conversation && typeof conversation.id === "string" ? conversation.id : null) ||
    conversationId;

  // Download all assets in parallel (much faster than sequential downloads)
  if (pointers.length > 0) {
    log.info(`[ChatGPT] Downloading ${pointers.length} assets in parallel`);
    const downloadPromises = pointers.map(async (ptr) => {
      const downloaded = await downloadAsset(accessToken, ptr, convIdForAssets);
      return { ptr, downloaded };
    });

    const results = await Promise.all(downloadPromises);
    results.forEach(({ ptr, downloaded }) => {
      if (downloaded) assets[ptr] = downloaded;
    });
  }

  return { conversation, assets };
}

// Main extraction: fetch conversation and download assets
import type { ExportOptions } from "../../formatters";

export async function extractChatGPTConversationData(
  _options: ExportOptions = {},
): Promise<ChatGPTRawExtraction> {
  if (!isChatGPTPlatform()) throw new Error("Not on a ChatGPT platform");
  const accessToken = await getAccessToken();
  const conversationId = extractChatGPTConversationId();
  return await fetchChatGPTConversation(accessToken, conversationId);
}
