import type { Chat } from "../../model/haevn_model";
import { log } from "../../utils/logger";
import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import {
  extractAIStudioConversationData,
  extractAIStudioConversationId,
  getAIStudioChatIds,
  isAIStudioPlatform,
} from "./extractor";
import type { AIStudioConversationData } from "./model";
import { transformAIStudioToHaevn } from "./transformer";

function normalizeId(value?: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value).trim().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function isMatchingChatUrl(currentHref: string, targetChatId: string): boolean {
  const normalizedTarget = normalizeId(targetChatId);
  if (!normalizedTarget) return false;

  // Preferred match: actual prompt id parsed from pathname.
  try {
    const currentChatId = extractAIStudioConversationId();
    const normalizedCurrent = normalizeId(currentChatId);
    if (normalizedCurrent === normalizedTarget) {
      return true;
    }
  } catch {
    // Not currently on /prompts/{id}; fall back to decoded href checks below.
  }

  // Fallback for AI Studio SPA routes/state where the id may be in query/hash.
  try {
    const decodedHref = decodeURIComponent(currentHref).toLowerCase();
    return decodedHref.includes(normalizedTarget);
  } catch {
    return currentHref.toLowerCase().includes(normalizedTarget);
  }
}

// Extractor implementation
const extractor: Extractor<AIStudioConversationData> = {
  isPlatform: () => {
    return isAIStudioPlatform();
  },

  extractChatIdFromUrl: (url: string) => {
    try {
      const urlObj = new URL(url);
      const match = urlObj.pathname.match(/\/prompts\/([^/?]+)/);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  },

  extractData: async (options) => {
    return await extractAIStudioConversationData(options);
  },

  getChatIds: async () => {
    return await getAIStudioChatIds();
  },

  // Note: AI Studio doesn't support getChatData - it requires DOM extraction from each page

  waitForReady: async (context?: { chatId?: string }) => {
    // Wait for AI Studio virtualized content to render.
    //
    // IMPORTANT: This runs in a hidden background tab during bulk sync. Chrome throttles
    // setTimeout in background tabs by ~10x (200ms → ~1900ms). Using a wall-clock timeout
    // prevents the intended 12s from becoming 114s in practice.
    const SELECTORS = {
      turn: "ms-chat-turn",
      textChunk: "ms-text-chunk",
    };

    const targetChatId = context?.chatId;
    const maxWaitMs = 60000; // 60s wall-clock limit (immune to timer throttling)
    const delay = 500; // poll interval — throttled to ~1000ms in bg tabs, that's fine
    const requiredStable = 2; // down from 3: saves ~2 throttled cycles (~4s) per chat
    let consecutiveStable = 0;
    let iteration = 0;
    const startTime = Date.now();

    log.debug(`[AI Studio Extractor] Waiting for content. Target chatId: ${targetChatId || "any"}`);

    while (Date.now() - startTime < maxWaitMs) {
      // Wake up the renderer every 3 iterations (every ~3s in background)
      if (iteration % 3 === 0) {
        window.scrollBy(0, 1);
        window.scrollBy(0, -1);
      }
      iteration++;

      // URL verification for SPA navigation
      if (targetChatId) {
        const currentUrl = window.location.href;
        if (!isMatchingChatUrl(currentUrl, targetChatId)) {
          log.debug(
            `[AI Studio Extractor] URL mismatch. Current: ${currentUrl}, Expected: ${targetChatId} (normalized). Waiting...`,
          );
          consecutiveStable = 0;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }

      const turns = document.querySelectorAll(SELECTORS.turn);
      if (turns.length === 0) {
        // Empty prompt: AI Studio renders ms-zero-state when there are no messages.
        // If it's present the page is fully loaded — return immediately rather than
        // waiting out the full 60s timeout.
        if (document.querySelector("ms-zero-state")) {
          log.info(
            `[AI Studio Extractor] Empty prompt detected (ms-zero-state), ready in ${Date.now() - startTime}ms`,
          );
          return;
        }
        consecutiveStable = 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      // Check if at least one turn has actual text content.
      // Use textContent (not innerText) — innerText returns empty for elements with
      // visibility:hidden (e.g. collapsed thinking panels) and for ALL elements in
      // some hidden-tab rendering states. textContent is CSS-independent and works
      // reliably in background tabs.
      let hasContent = false;
      for (const turn of turns) {
        const textChunks = turn.querySelectorAll(SELECTORS.textChunk);
        const promptChunks = turn.querySelectorAll("ms-prompt-chunk");
        const hasRenderedText = Array.from(textChunks).some(
          (chunk) => (chunk as HTMLElement).textContent?.trim().length > 0,
        );
        const hasRenderedPrompt = Array.from(promptChunks).some(
          (chunk) => (chunk as HTMLElement).textContent?.trim().length > 0,
        );

        if (hasRenderedText || hasRenderedPrompt) {
          hasContent = true;
          break;
        }
      }

      if (hasContent) {
        consecutiveStable++;
        if (consecutiveStable >= requiredStable) {
          log.info(
            `[AI Studio Extractor] Content and URL are ready (${Date.now() - startTime}ms elapsed)`,
          );
          return;
        }
      } else {
        consecutiveStable = 0;
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    log.error(`[AI Studio Extractor] Content wait timed out after ${maxWaitMs}ms.`);
    throw new Error(`Content did not load or URL mismatch (Expected chatId: ${targetChatId})`);
  },
};

// Transformer implementation
const transformer: Transformer<AIStudioConversationData> = {
  transform: async (raw: AIStudioConversationData) => {
    const chat = await transformAIStudioToHaevn(raw);
    return [chat as Chat];
  },

  validate: (raw: AIStudioConversationData) => {
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
export const aistudioProvider: Provider<AIStudioConversationData> = {
  name: "aistudio",
  displayName: "Google AI Studio",

  extractor,
  transformer,

  bulkSyncConfig: {
    mode: "navigation",
    waitForContentReady: true,
    rateLimitDelayMs: 1000,
    requiresActiveTab: true,
  },

  getListUrl(): string {
    return "https://aistudio.google.com/library";
  },

  buildChatUrl(chatId: string): string {
    return `https://aistudio.google.com/prompts/${chatId}`;
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
