import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractQwenChatIds,
  extractQwenConversationData,
  fetchQwenConversation,
  isQwenPlatform,
} from "./extractor";
import type { QwenChatData } from "./model";
import { transformQwenToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<QwenChatData> = {
  isPlatform: () => {
    return isQwenPlatform();
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
    return await extractQwenConversationData(options);
  },

  getChatIds: async () => {
    return await extractQwenChatIds();
  },

  getChatData: async (chatId: string) => {
    return await fetchQwenConversation(chatId);
  },
};

// Transformer implementation
const transformer: Transformer<QwenChatData> = {
  transform: async (raw: QwenChatData, tabId?: number) => {
    const chat = await transformQwenToHaevn(raw, tabId);
    return [chat as Chat];
  },

  validate: (raw: QwenChatData) => {
    const errors: string[] = [];

    if (!raw.id) {
      errors.push("Missing id");
    }
    if (!raw.chat?.history?.messages) {
      errors.push("Missing or invalid messages");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const qwenProvider: Provider<QwenChatData> = {
  name: "qwen",
  displayName: "Qwen",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  getListUrl(): string {
    return "https://chat.qwen.ai/";
  },

  buildChatUrl(chatId: string): string {
    return `https://chat.qwen.ai/c/${chatId}`;
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
