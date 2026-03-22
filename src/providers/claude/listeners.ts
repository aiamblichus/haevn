/**
 * Claude Token Capture Listener
 * Intercepts API requests to Claude to capture authentication information
 * The organizationId is required for API requests
 */

import { log } from "../../utils/logger";

/**
 * Set up webRequest listener to capture Claude authentication tokens
 * This passively observes requests that Claude's own UI makes, extracting
 * the authentication information we need for our API calls
 */
export function setupClaudeListeners() {
  // Capture organizationId from cookies whenever Claude API is accessed
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      try {
        const url = new URL(details.url);
        const pathMatch = url.pathname.match(/\/api\/organizations\/([^/]+)\/chat_conversations/);

        if (pathMatch?.[1]) {
          const organizationId = pathMatch[1];

          log.debug("[ClaudeTokenCapture] Captured organizationId from API path", {
            organizationId,
            url: details.url,
          });

          // Store in chrome.storage.local so content scripts can access
          chrome.storage.local.set({
            claudeAuthTokens: {
              organizationId,
              capturedAt: Date.now(),
            },
          });

          log.info("[ClaudeTokenCapture] Stored organizationId", {
            organizationId,
          });
        }
      } catch (err) {
        log.debug("[ClaudeTokenCapture] Failed to parse request URL", err);
      }
      return {};
    },
    {
      urls: ["https://claude.ai/api/organizations/*/chat_conversations*"],
      types: ["xmlhttprequest"],
    },
    ["requestHeaders"],
  );

  log.info("[ClaudeTokenCapture] Listener registered for Claude API requests");
}
