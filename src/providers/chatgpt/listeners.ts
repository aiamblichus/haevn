/**
 * ChatGPT Token Capture Listener
 * Intercepts auth session API responses to capture access tokens
 * The accessToken is required for backend API requests
 */

import { log } from "../../utils/logger";

/**
 * Set up webRequest listener to capture ChatGPT authentication tokens
 * This passively observes the auth/session endpoint response
 */
export function setupChatGPTListeners() {
  // Capture accessToken from auth/session response
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      // We can't read the response body directly in webRequest
      // So we'll trigger a content script to read it via fetch
      if (details.tabId && details.tabId !== -1) {
        // Send message to content script to fetch and store the token
        chrome.tabs
          .sendMessage(details.tabId, {
            action: "captureChatGPTToken",
            url: details.url,
          })
          .catch((err) => {
            log.debug("[ChatGPTTokenCapture] Could not send message to tab", err);
          });
      }
    },
    {
      urls: ["https://chatgpt.com/api/auth/session", "https://chat.openai.com/api/auth/session"],
      types: ["xmlhttprequest"],
    },
  );

  log.info("[ChatGPTTokenCapture] Listener registered for ChatGPT auth/session endpoint");
}

/**
 * Extract and store ChatGPT access token from auth/session response
 * This should be called from content script context when the auth/session request completes
 */
export async function captureAndStoreChatGPTToken(): Promise<void> {
  try {
    const origins = ["https://chatgpt.com", "https://chat.openai.com"];
    for (const origin of origins) {
      try {
        const resp = await fetch(`${origin}/api/auth/session`, {
          credentials: "include",
        });
        if (!resp.ok) continue;

        const json = await resp.json();
        const accessToken = json?.accessToken;

        if (accessToken && typeof accessToken === "string") {
          await chrome.storage.local.set({
            chatgptAuthTokens: {
              accessToken,
              capturedAt: Date.now(),
            },
          });

          log.info("[ChatGPTTokenCapture] Captured and stored accessToken", {
            origin,
          });
          return;
        }
      } catch (err) {
        log.debug(`[ChatGPTTokenCapture] Failed to fetch from ${origin}`, err);
      }
    }
  } catch (err) {
    log.warn("[ChatGPTTokenCapture] Failed to capture access token", err);
  }
}
