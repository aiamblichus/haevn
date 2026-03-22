import { log } from "../../utils/logger";
import type { ExportOptions, Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { getPoeChatData, getPoeChatIds, isPoePlatform } from "./extractor";
import { setupPoeListeners } from "./listeners";
import type { PoeConversationData } from "./model";
import { transformPoeToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<PoeConversationData> = {
  isPlatform: () => {
    return isPoePlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/\/chat\/([^/?]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  getChatData: async (chatId: string, baseUrl: string) => {
    return await getPoeChatData(chatId, baseUrl);
  },

  getChatIds: async () => {
    return await getPoeChatIds();
  },

  extractData: async (_options: ExportOptions) => {
    throw new Error("Not implemented");
  },

  waitForReady: async () => {
    // Wait for Poe page to be stable with messages visible
    const SELECTORS = {
      chats_scroll_container: 'div[class*="MainColumn_scrollSection"]',
      scroll_container: 'div[class*="ChatMessagesScrollWrapper_scrollableContainerWrapper"]',
      chat_message: '[class*="ChatMessage_messageRow"]',
    };

    const maxAttempts = 30;
    const delay = 200;
    const requiredStableChecks = 3;

    // First wait for the chats scroll container
    for (let i = 0; i < 25; i++) {
      const scrollContainer = document.querySelector(SELECTORS.chats_scroll_container);
      if (scrollContainer) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Then wait for page stability
    let lastUrl = window.location.href;
    let stableCount = 0;

    for (let i = 0; i < maxAttempts; i++) {
      const currentUrl = window.location.href;
      if (currentUrl !== lastUrl) {
        lastUrl = currentUrl;
        stableCount = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      const scrollContainer = document.querySelector(SELECTORS.scroll_container);
      const hasMessages = document.querySelectorAll(SELECTORS.chat_message).length > 0;

      if (scrollContainer && hasMessages) {
        stableCount++;
        if (stableCount >= requiredStableChecks) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          if (window.location.href === lastUrl) {
            return;
          }
          lastUrl = window.location.href;
          stableCount = 0;
        }
      } else {
        stableCount = 0;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    // Timeout is acceptable for Poe - proceed anyway
  },
};

// Transformer implementation
const transformer: Transformer<PoeConversationData> = {
  transform: async (raw: PoeConversationData) => {
    return await transformPoeToHaevn(raw);
  },

  validate: (raw: PoeConversationData) => {
    const errors: string[] = [];

    if (!raw.chatId) {
      errors.push("Missing chatId");
    }
    if (!raw.chatCode) {
      errors.push("Missing chatCode");
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
export const poeProvider: Provider<PoeConversationData> = {
  name: "poe",
  displayName: "Poe",

  extractor,
  transformer,

  // Poe uses GraphQL API but as an SPA needs extra delay for navigation
  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 2000,
  },

  getListUrl(): string {
    return "https://poe.com/chats";
  },

  buildChatUrl(chatId: string): string {
    return `https://poe.com/chat/${chatId}`;
  },

  setup: async () => {
    setupPoeListeners();
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
