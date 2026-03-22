import { log } from "../../utils/logger";
import { fetchWithTimeout } from "../../utils/network_utils";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import type { QwenChatListResponse, QwenChatResponse } from "./model";

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

// Fetch full conversation JSON via Qwen API
export async function fetchQwenConversation(chatId: string): Promise<QwenChatResponse["data"]> {
  const apiUrl = `https://chat.qwen.ai/api/v2/chats/${chatId}`;
  const response = await fetchWithTimeout(apiUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeoutMs: 30000,
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch conversation ${chatId}: ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as QwenChatResponse;
  if (!data.success) {
    throw new Error(`API returned success=false for conversation ${chatId}`);
  }
  return data.data;
}

// Main extraction function
import type { ExportOptions } from "../../formatters";

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
  const response = await fetchWithTimeout(apiUrl, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    timeoutMs: 30000,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch chat list: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as QwenChatListResponse;
  if (!data.success) {
    throw new Error("API returned success=false for chat list");
  }

  return data.data.map((chat) => chat.id);
}
