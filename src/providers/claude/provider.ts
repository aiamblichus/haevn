import type { Chat } from "../../model/haevn_model";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractClaudeChatIds,
  extractClaudeConversationData,
  fetchClaudeConversation,
  isClaudePlatform,
} from "./extractor";
import { setupClaudeListeners } from "./listeners";
import type { ChatTranscript } from "./model";
import { convertClaudeTranscriptToHaevn } from "./transformer";

// Extractor implementation
const extractor: Extractor<ChatTranscript> = {
  isPlatform: () => {
    return isClaudePlatform();
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

  extractData: async (options) => {
    return await extractClaudeConversationData(options);
  },

  getChatIds: async () => {
    return await extractClaudeChatIds();
  },

  getChatData: async (chatId: string) => {
    // Extract organization ID from cookies
    const cookies = document.cookie.split(";");
    const lastActiveOrgCookie = cookies
      .find((cookie) => cookie.trim().startsWith("lastActiveOrg="))
      ?.trim();

    if (!lastActiveOrgCookie) {
      throw new Error("Could not find organizationId");
    }

    const orgId = lastActiveOrgCookie.split("=")[1];
    return await fetchClaudeConversation(orgId, chatId);
  },
};

// Transformer implementation
const transformer: Transformer<ChatTranscript> = {
  transform: async (raw: ChatTranscript) => {
    const chat = await convertClaudeTranscriptToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: ChatTranscript) => {
    const errors: string[] = [];

    if (!raw.uuid) {
      errors.push("Missing uuid");
    }
    if (!raw.chat_messages || !Array.isArray(raw.chat_messages)) {
      errors.push("Missing or invalid chat_messages array");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

// Provider implementation
export const claudeProvider: Provider<ChatTranscript> = {
  name: "claude",
  displayName: "Claude",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "api",
    rateLimitDelayMs: 200,
  },

  setup() {
    setupClaudeListeners();
  },

  getListUrl(): string {
    return "https://claude.ai/";
  },

  buildChatUrl(chatId: string): string {
    return `https://claude.ai/chat/${chatId}`;
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
