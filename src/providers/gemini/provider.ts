import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { extractGeminiChatIds, extractGeminiConversationData, isGeminiPlatform } from "./extractor";
import type { GeminiConversationData } from "./model";
import { transformGeminiToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<GeminiConversationData> = {
  isPlatform: () => {
    return isGeminiPlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    try {
      const urlObj = new URL(url);
      const pathSegments = urlObj.pathname.split("/").filter(Boolean);
      // Gemini URLs: /app/{chatId}
      if (pathSegments.length >= 2 && pathSegments[0] === "app") {
        return pathSegments[1];
      }
      return null;
    } catch {
      return null;
    }
  },

  extractData: async (options) => {
    return await extractGeminiConversationData(options);
  },

  getChatIds: async () => {
    return await extractGeminiChatIds();
  },

  // Note: Gemini doesn't support getChatData - it requires DOM extraction from each page
};

// Transformer implementation
const transformer: Transformer<GeminiConversationData> = {
  transform: async (raw: GeminiConversationData, tabId?: number) => {
    const chat = await transformGeminiToHaevn(raw, tabId);
    return [chat as Chat];
  },

  validate: (raw: GeminiConversationData) => {
    const errors: string[] = [];

    if (!raw.conversationId) {
      errors.push("Missing conversationId");
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
export const geminiProvider: Provider<GeminiConversationData> = {
  name: "gemini",
  displayName: "Google Gemini",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "navigation",
    rateLimitDelayMs: 1000,
  },

  getListUrl(): string {
    return "https://gemini.google.com/app";
  },

  buildChatUrl(chatId: string): string {
    // IDs are already normalized (no 'c_' prefix)
    return `https://gemini.google.com/app/${chatId}`;
  },

  async checkAvailability(): Promise<{
    available: boolean;
    count?: number;
    tabId?: number;
    reason?: string;
  }> {
    // Availability checking removed - sync is initiated from popup
    return {
      available: false,
      reason: "Use popup to sync from provider page",
    };
  },
};
