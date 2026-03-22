import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractChatGPTChatIds,
  extractChatGPTConversationData,
  fetchChatGPTConversation,
  getAccessToken,
  isChatGPTPlatform,
} from "./extractor";
import { setupChatGPTListeners } from "./listeners";
import type { ChatGPTRawExtraction } from "./model";
import { transformOpenAIToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<ChatGPTRawExtraction> = {
  isPlatform: () => {
    return isChatGPTPlatform();
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
    return await extractChatGPTConversationData(options);
  },

  getChatIds: async () => {
    return await extractChatGPTChatIds();
  },

  getChatData: async (chatId: string) => {
    const accessToken = await getAccessToken();
    return await fetchChatGPTConversation(accessToken, chatId);
  },
};

// Transformer implementation
const transformer: Transformer<ChatGPTRawExtraction> = {
  transform: async (raw: ChatGPTRawExtraction) => {
    const chat = transformOpenAIToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: ChatGPTRawExtraction) => {
    const errors: string[] = [];

    if (!raw.conversation) {
      errors.push("Missing conversation object");
    } else {
      if (!raw.conversation.id && !raw.conversation.conversation_id) {
        errors.push("Missing conversation id");
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const chatgptProvider: Provider<ChatGPTRawExtraction> = {
  name: "chatgpt",
  displayName: "ChatGPT",
  color: "bg-green-500",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  setup() {
    setupChatGPTListeners();
  },

  getListUrl(): string {
    return "https://chatgpt.com/";
  },

  buildChatUrl(chatId: string): string {
    return `https://chatgpt.com/c/${chatId}`;
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
