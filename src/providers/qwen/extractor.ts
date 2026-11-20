import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import type {
  QwenChatData,
  QwenChatListResponse,
  QwenChatResponse,
  QwenFailureData,
  QwenFailureResponse,
} from "./model";

// Platform Detection
export function isQwenPlatform(): boolean {
  return detectPlatform({
    hostnames: ["chat.qwen.ai"],
  });
}

// Conversation ID Extraction
export function extractQwenConversationId(): string {
  const pathname = window.location.pathname;
  try {
    // Qwen URLs are like /c/{chatId}
    const qwenMatch = pathname.match(/\/c\/([a-f0-9-]{36})/);
    return qwenMatch ? qwenMatch[1] : generateFallbackId("qwen");
  } catch (error) {
    log.error("Error extracting Qwen conversation ID:", error);
    return generateFallbackId("qwen");
  }
}

/**
 * The session token Qwen keeps in the page's localStorage. The API answers Unauthorized to a request
 * that carries only cookies, so the token goes with each request as a bearer (HVN-115). It is never
 * logged and never put in an error. Null when the page holds none.
 */
function qwenSessionToken(): string | null {
  try {
    const token = localStorage.getItem("token");
    return token ? token : null;
  } catch (err) {
    log.warn("[Qwen] Could not read the session token from localStorage:", err);
    return null;
  }
}

function qwenHeaders(token: string | null): Record<string, string> {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * The error for an answer with success=false. With no session token, an Unauthorized answer means
 * the browser is not signed in, and the message says so in words the health check reads as "not
 * signed in". With a token, the request of a signed-in user failed: the message must not read as a
 * sign-in problem, or the health check reports a signed-in user as signed out (HVN-115).
 */
function qwenRejection(
  what: string,
  data: QwenFailureData | null | undefined,
  token: string | null,
): Error {
  const code = data?.code;
  if (token === null && code === "Unauthorized") {
    return new Error(
      `Not signed in to Qwen: ${what} was refused, and the browser holds no session token`,
    );
  }
  log.warn(`[Qwen] ${what} answered success=false`, { code });
  return new Error(`Qwen answered success=false for ${what}`);
}

// Fetch full conversation JSON via Qwen API
export async function fetchQwenConversation(chatId: string): Promise<QwenChatData> {
  const apiUrl = `https://chat.qwen.ai/api/v2/chats/${chatId}`;
  const token = qwenSessionToken();
  const response = await fetchWithTimeout(apiUrl, {
    method: "GET",
    credentials: "include",
    headers: qwenHeaders(token),
    timeoutMs: 30000,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation ${chatId}: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as QwenChatResponse | QwenFailureResponse;
  if (!data.success) {
    throw qwenRejection(`conversation ${chatId}`, data.data, token);
  }
  return data.data;
}

// Main extraction function
import type { ExportOptions } from "../interfaces";

export async function extractQwenConversationData(
  _options: ExportOptions = {},
): Promise<QwenChatResponse["data"]> {
  if (!isQwenPlatform()) {
    throw new Error("Not on a Qwen platform");
  }

  const conversationId = extractQwenConversationId();
  const chatData = await fetchQwenConversation(conversationId);
  return chatData;
}

export async function extractQwenChatIds(): Promise<string[]> {
  const apiUrl = "https://chat.qwen.ai/api/v2/chats/";
  const token = qwenSessionToken();
  const response = await fetchWithTimeout(apiUrl, {
    method: "GET",
    credentials: "include",
    headers: qwenHeaders(token),
    timeoutMs: 30000,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch chat list: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as QwenChatListResponse | QwenFailureResponse;
  if (!data.success) {
    throw qwenRejection("the chat list", data.data, token);
  }

  return data.data.map((chat) => chat.id);
}
