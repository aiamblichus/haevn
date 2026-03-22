import { log } from "../../utils/logger";
import { detectPlatform } from "../shared/platformDetector";
import { generateFallbackId } from "../shared_utils";
import { deepseekApi } from "./api_client";
import type { DeepseekConversationData } from "./model";

const CHAT_ID_REGEX = /\/a\/chat\/s\/([^/?#]+)/i;

export function isDeepseekPlatform(): boolean {
  return detectPlatform({
    hostnames: ["chat.deepseek.com"],
  });
}

export function extractDeepseekConversationId(): string {
  try {
    const match = window.location.pathname.match(CHAT_ID_REGEX);
    return match?.[1] || generateFallbackId("deepseek");
  } catch (error) {
    log.error("[DeepSeek] Failed to extract conversation id:", error);
    return generateFallbackId("deepseek");
  }
}

/**
 * Fetch DeepSeek conversation data via API.
 * This is the primary method for fetching conversations.
 */
export async function fetchDeepseekConversation(
  chatSessionId: string,
): Promise<DeepseekConversationData> {
  log.info("[DeepSeek] Fetching conversation via API", { chatSessionId });

  const response = await deepseekApi.fetchConversation(chatSessionId);

  const session = response.data.biz_data.chat_session;
  const messages = response.data.biz_data.chat_messages;

  log.info("[DeepSeek] Fetched conversation via API", {
    chatSessionId,
    title: session.title,
    messageCount: messages.length,
  });

  return {
    sourceId: chatSessionId,
    title: session.title || "DeepSeek Chat",
    url: `https://chat.deepseek.com/a/chat/s/${chatSessionId}`,
    extractedAt: new Date().toISOString(),
    session,
    messages,
  };
}

export async function extractDeepseekChatIds(): Promise<string[]> {
  if (!isDeepseekPlatform()) {
    throw new Error("Not on DeepSeek platform");
  }

  // Use API to get all chat IDs (faster and more reliable than DOM extraction)
  log.info("[DeepSeek] Fetching chat IDs via API...");
  const chatIds = await deepseekApi.fetchAllChatIds();

  if (chatIds.length === 0) {
    throw new Error("No DeepSeek chats found");
  }

  log.info(`[DeepSeek] Fetched ${chatIds.length} chat IDs via API`);
  return chatIds;
}
