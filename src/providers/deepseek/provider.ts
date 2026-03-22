import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { extractDeepseekChatIds, fetchDeepseekConversation, isDeepseekPlatform } from "./extractor";
import type { DeepseekConversationData } from "./model";
import { transformDeepseekToHaevn } from "./transformer";

function normalizeBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return "https://chat.deepseek.com";
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

// Extractor implementation - API only
const extractor: Extractor<DeepseekConversationData> = {
  isPlatform: () => {
    return isDeepseekPlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/\/a\/chat\/s\/([^/?]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  extractData: async () => {
    // DeepSeek uses API-only extraction
    throw new Error("DeepSeek extractData is deprecated. Use getChatData instead.");
  },

  getChatIds: async () => {
    return await extractDeepseekChatIds();
  },

  getChatData: async (chatId: string) => {
    return await fetchDeepseekConversation(chatId);
  },
};

// Transformer implementation
const transformer: Transformer<DeepseekConversationData> = {
  transform: async (raw: DeepseekConversationData) => {
    const chat = await transformDeepseekToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: DeepseekConversationData) => {
    const errors: string[] = [];

    if (!raw.sourceId) {
      errors.push("Missing sourceId");
    }
    if (!raw.messages || !Array.isArray(raw.messages)) {
      errors.push("Missing or invalid messages array");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const deepseekProvider: Provider<DeepseekConversationData> = {
  name: "deepseek",
  displayName: "DeepSeek",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  getListUrl(baseUrl?: string): string {
    return `${normalizeBaseUrl(baseUrl)}/`;
  },

  buildChatUrl(chatId: string, baseUrl?: string): string {
    return `${normalizeBaseUrl(baseUrl)}/a/chat/s/${chatId}`;
  },

  async checkAvailability(): Promise<{
    available: boolean;
    count?: number;
    tabId?: number;
    reason?: string;
  }> {
    // Availability checking is handled via Options/Popup flows
    return {
      available: false,
      reason: "Open DeepSeek and use popup or Options to sync.",
    };
  },
};
