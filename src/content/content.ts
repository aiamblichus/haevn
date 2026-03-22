// HAEVN Content Script
// Provides: ping, platform detection, and data extraction for supported platforms.

import type { ExportOptions } from "../formatters";
import { registerAllProviders } from "../providers/index";
import { getProvider } from "../providers/provider";
import type { ContentScriptResponse } from "../types/messaging";
import { isContentScriptRequest } from "../types/messaging";
import { log } from "../utils/logger";
import { detectCurrentPlatform, getConversationId } from "../utils/platform";

log.debug("[HAEVN][Content] Script loading...");
registerAllProviders();
log.debug("[HAEVN][Content] Script loaded");

// ============================================================================
// Core Extraction Functions
// ============================================================================

async function extractDataForPlatform(
  platformName: string,
  options: ExportOptions,
): Promise<unknown> {
  const provider = getProvider(platformName);
  if (!provider) {
    throw new Error(`Unknown platform: ${platformName}`);
  }

  // Check if provider supports extractData
  if (!provider.extractor.extractData) {
    throw new Error(
      `Platform ${platformName} does not support DOM extraction. Use getChatData instead.`,
    );
  }

  return await provider.extractor.extractData(options);
}

async function getChatIdsForPlatform(platformName: string): Promise<string[]> {
  const provider = getProvider(platformName);
  if (!provider) {
    throw new Error(`Unknown platform: ${platformName}`);
  }

  if (!provider.extractor.getChatIds) {
    throw new Error(`Bulk export not implemented for platform: ${platformName}`);
  }

  return await provider.extractor.getChatIds();
}

async function fetchChatDataForPlatform(
  platformName: string,
  chatId: string,
  baseUrl?: string,
): Promise<unknown> {
  const provider = getProvider(platformName);
  if (!provider) {
    throw new Error(`Unknown platform: ${platformName}`);
  }

  if (!provider.extractor.getChatData) {
    throw new Error(`API fetch not implemented for platform: ${platformName}`);
  }

  return await provider.extractor.getChatData(chatId, baseUrl);
}

// ============================================================================
// Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (response: ContentScriptResponse) => void) => {
    try {
      if (!isContentScriptRequest(message)) {
        return;
      }

      log.debug("[HAEVN][Content] Received message:", message.action || message.type, message);

      if (!("action" in message)) {
        return;
      }

      // Synchronous handlers
      switch (message.action) {
        case "ping":
          sendResponse({ status: "ready" });
          return;

        case "detectPlatform": {
          const platform = detectCurrentPlatform();
          log.info("[HAEVN][Content] Detected platform:", platform);
          sendResponse({ platform });
          return;
        }

        case "getConversationId": {
          const conversationId = getConversationId();
          sendResponse({ conversationId });
          return;
        }
      }

      // Async handlers
      switch (message.action) {
        case "extractData":
          handleExtractData(message, sendResponse);
          return true;

        case "getChatIds":
          handleGetChatIds(sendResponse);
          return true;

        // Generic waitForReady - delegates to provider's extractor.waitForReady()
        case "waitForReady":
          handleWaitForReady(message, sendResponse);
          return true;

        // Generic fetchConversation - delegates to provider's extractor.getChatData()
        case "fetchConversation":
          handleFetchConversation(
            message.platformName || detectCurrentPlatform().name,
            message,
            sendResponse,
          );
          return true;

        // Provider-specific fetch handlers for bulk sync (legacy, kept for compatibility)
        case "fetchClaudeConversation":
          handleFetchConversation("claude", message, sendResponse);
          return true;

        case "fetchChatGPTConversation":
          handleFetchConversation("chatgpt", message, sendResponse);
          return true;

        case "fetchOpenWebUIConversation":
          handleFetchConversation("openwebui", message, sendResponse);
          return true;

        case "fetchQwenConversation":
          handleFetchConversation("qwen", message, sendResponse);
          return true;

        case "fetchDeepseekConversation":
          handleFetchConversation("deepseek", message, sendResponse);
          return true;

        case "fetchPoeConversation":
          handleFetchConversation("poe", message, sendResponse);
          return true;

        // Legacy AI Studio wait handler - now uses generic waitForReady
        case "waitForAIStudioContent":
          handleWaitForReady({ chatId: message.chatId }, sendResponse);
          return true;

        case "fetchBlob":
          handleFetchBlob(message, sendResponse);
          return true;

        default:
          log.warn("[HAEVN][Content] Unknown action:", message.action);
          sendResponse({
            success: false,
            error: `Unknown action: ${message.action}`,
          });
      }
    } catch (err: unknown) {
      log.error("[HAEVN][Content] Listener threw error:", err);
      sendResponse({
        success: false,
        error: (err as Error)?.message || "Unhandled error",
      });
    }
  },
);

// ============================================================================
// Handler Implementations
// ============================================================================

function handleExtractData(
  message: { options?: ExportOptions; chatId?: string },
  sendResponse: (response: ContentScriptResponse) => void,
): void {
  const platform = detectCurrentPlatform();
  const options: ExportOptions = message.options || {};
  const chatId = message.chatId;

  (async () => {
    try {
      // Special handling for Poe - uses API, not DOM extraction
      if (platform.name === "poe") {
        throw new Error(
          "Poe uses API-based extraction. Use fetchPoeConversation with a chatId instead.",
        );
      }

      // Special handling for DeepSeek - uses API, not DOM extraction
      if (platform.name === "deepseek") {
        throw new Error(
          "DeepSeek uses API-only extraction. Use fetchDeepseekConversation action instead.",
        );
      }

      // Get provider and wait for ready if supported
      const provider = getProvider(platform.name);
      if (provider?.extractor.waitForReady) {
        await provider.extractor.waitForReady({ chatId });
      }

      const data = await extractDataForPlatform(platform.name, options);

      log.info("[HAEVN][Content] Extracted data summary:", {
        platform: platform.name,
        title: (data as Record<string, unknown>)?.title,
        messageCount: Array.isArray((data as Record<string, unknown>)?.messages)
          ? ((data as Record<string, unknown>).messages as unknown[]).length
          : undefined,
      });

      sendResponse({ success: true, data, platform });
    } catch (err: unknown) {
      log.error("[HAEVN][Content] extractData error:", err);
      try {
        sendResponse({
          success: false,
          error: (err as Error)?.message || "Extraction failed",
        });
      } catch (responseErr) {
        log.error("[HAEVN][Content] Failed to send error response (channel closed):", responseErr);
      }
    }
  })();
}

function handleGetChatIds(sendResponse: (response: ContentScriptResponse) => void): void {
  const platform = detectCurrentPlatform();

  (async () => {
    try {
      const chatIds = await getChatIdsForPlatform(platform.name);
      sendResponse({ success: true, chatIds });
    } catch (err: unknown) {
      log.error("[HAEVN][Content] getChatIds error:", err);
      sendResponse({
        success: false,
        error: (err as Error)?.message || "Failed to get chat IDs",
      });
    }
  })();
}

function handleWaitForReady(
  message: { chatId?: string },
  sendResponse: (response: ContentScriptResponse) => void,
): void {
  const platform = detectCurrentPlatform();

  (async () => {
    try {
      const provider = getProvider(platform.name);
      if (!provider) {
        throw new Error(`Unknown platform: ${platform.name}`);
      }

      if (provider.extractor.waitForReady) {
        await provider.extractor.waitForReady({ chatId: message.chatId });
        log.info(`[HAEVN][Content] waitForReady completed for ${platform.name}`);
      } else {
        log.debug(`[HAEVN][Content] ${platform.name} has no waitForReady, proceeding immediately`);
      }

      sendResponse({ success: true });
    } catch (err: unknown) {
      log.error("[HAEVN][Content] waitForReady error:", err);
      sendResponse({
        success: false,
        error: (err as Error)?.message || "waitForReady failed",
      });
    }
  })();
}

function handleFetchConversation(
  platformName: string,
  message: { chatId?: string },
  sendResponse: (response: ContentScriptResponse) => void,
): void {
  (async () => {
    try {
      const { chatId } = message;
      if (!chatId) {
        throw new Error("chatId is required");
      }
      const data = await fetchChatDataForPlatform(platformName, chatId);
      sendResponse({ success: true, data });
    } catch (err: unknown) {
      log.error(`[HAEVN][Content] fetch${platformName}Conversation error:`, err);
      sendResponse({
        success: false,
        error: (err as Error)?.message || "Failed to fetch conversation",
      });
    }
  })();
}

function handleFetchBlob(
  message: { url: string; credentials?: RequestCredentials },
  sendResponse: (response: ContentScriptResponse) => void,
): void {
  (async () => {
    try {
      log.debug("[HAEVN][Content] Fetching blob:", message.url);
      const response = await fetch(message.url, {
        credentials: message.credentials ?? "include",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const blob = await response.blob();

      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result as string;
        // result is "data:content/type;base64,....."
        const [header, base64] = result.split(",");
        const contentType = header.split(":")[1].split(";")[0];

        sendResponse({ success: true, base64, contentType });
      };
      reader.onerror = () => {
        sendResponse({ success: false, error: "Failed to read blob" });
      };
      reader.readAsDataURL(blob);
    } catch (err: unknown) {
      log.error("[HAEVN][Content] fetchBlob error:", err);
      sendResponse({
        success: false,
        error: (err as Error)?.message || "Failed to fetch blob",
      });
    }
  })();
}
