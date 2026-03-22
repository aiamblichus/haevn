import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractGrokChatIds,
  extractGrokConversationData,
  extractGrokConversationIdFromUrl,
  fetchGrokChatData,
  isGrokPlatform,
} from "./extractor";
import type { GrokRawExtraction } from "./model";
import { convertGrokToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<GrokRawExtraction> = {
  isPlatform: () => {
    return isGrokPlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    return extractGrokConversationIdFromUrl(url);
  },

  extractData: async (options) => {
    return await extractGrokConversationData(options);
  },

  getChatIds: async () => {
    return await extractGrokChatIds();
  },

  getChatData: async (chatId: string, baseUrl?: string) => {
    return await fetchGrokChatData(chatId, baseUrl);
  },
};

// Transformer implementation
const transformer: Transformer<GrokRawExtraction> = {
  transform: async (raw: GrokRawExtraction) => {
    const chat = await convertGrokToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: GrokRawExtraction) => {
    const errors: string[] = [];

    if (!raw.conversation) {
      errors.push("Missing conversation");
    }
    if (!raw.conversation?.conversationId) {
      errors.push("Missing conversationId");
    }
    if (!raw.responseNodes || !Array.isArray(raw.responseNodes)) {
      errors.push("Missing or invalid responseNodes array");
    }
    if (!raw.responses || !Array.isArray(raw.responses)) {
      errors.push("Missing or invalid responses array");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const grokProvider: Provider<GrokRawExtraction> = {
  name: "grok",
  displayName: "Grok",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  setup() {
    // Grok uses cookies for authentication (credentials: "include")
    // No special listeners needed
  },

  getListUrl(): string {
    return "https://grok.com/";
  },

  buildChatUrl(chatId: string): string {
    return `https://grok.com/c/${chatId}`;
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
