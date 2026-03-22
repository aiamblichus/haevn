import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractOpenWebUIChatIds,
  extractOpenWebUIConversationData,
  fetchOpenWebUIConversation,
  isOpenWebUIPlatform,
} from "./extractor";
import type { OpenWebUIRawExtraction } from "./model";
import { transformOpenWebUIToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<OpenWebUIRawExtraction> = {
  isPlatform: () => {
    return isOpenWebUIPlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/\/c\/([^/?]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  extractData: async (options) => {
    return await extractOpenWebUIConversationData(options);
  },

  getChatIds: async () => {
    return await extractOpenWebUIChatIds();
  },

  getChatData: async (chatId: string) => {
    return await fetchOpenWebUIConversation(chatId);
  },
};

// Transformer implementation
const transformer: Transformer<OpenWebUIRawExtraction> = {
  transform: async (raw: OpenWebUIRawExtraction) => {
    const chat = transformOpenWebUIToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: OpenWebUIRawExtraction) => {
    const errors: string[] = [];

    if (!raw.chat) {
      errors.push("Missing chat object");
    } else {
      if (!raw.chat.id) {
        errors.push("Missing chat id");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const openwebuiProvider: Provider<OpenWebUIRawExtraction> = {
  name: "openwebui",
  displayName: "Open WebUI",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  getListUrl(baseUrl?: string): string {
    if (!baseUrl) {
      throw new Error("baseUrl is required for Open WebUI");
    }
    return baseUrl;
  },

  buildChatUrl(chatId: string, baseUrl?: string): string {
    if (!baseUrl) {
      throw new Error("baseUrl is required for Open WebUI");
    }
    try {
      const url = new URL(baseUrl);
      return `${url.origin}/c/${chatId}`;
    } catch {
      return `${baseUrl}/c/${chatId}`;
    }
  },

  async checkAvailability(_baseUrl?: string): Promise<{
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
