/**
 * Poe Token Capture Listener
 * Intercepts GraphQL requests to Poe.com to capture authentication headers
 * These headers (formkey, tag-id, tchannel) are required for API requests
 */

import { log } from "../../utils/logger";

/**
 * Set up webRequest listener to capture Poe authentication tokens
 * This passively observes requests that Poe's own UI makes, extracting
 * the headers we need for our API calls
 */
export function setupPoeListeners() {
  // Capture tokens from headers
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const headers = details.requestHeaders || [];
      const tokens: Record<string, string> = {};

      // Extract Poe-specific headers
      for (const header of headers) {
        const name = header.name.toLowerCase();
        const value = header.value;

        if (!value) continue;

        switch (name) {
          case "poe-formkey":
            tokens.formkey = value;
            break;
          case "poe-tag-id":
            tokens.tagId = value;
            break;
          case "poe-tchannel":
            tokens.tchannel = value;
            break;
          case "poe-revision":
            tokens.revision = value;
            break;
        }
      }

      // If we captured any tokens, store them in chrome.storage for cross-context access
      if (Object.keys(tokens).length > 0) {
        // Store in chrome.storage.local so content scripts can access
        chrome.storage.local.set({
          poeTokens: {
            ...tokens,
            capturedAt: Date.now(),
          },
        });

        log.debug("[PoeTokenCapture] Captured and stored tokens:", {
          keys: Object.keys(tokens),
          url: details.url,
        });
      }
      return {};
    },
    {
      urls: ["https://poe.com/api/gql_POST"],
      types: ["xmlhttprequest"],
    },
    ["requestHeaders", "extraHeaders"],
  );

  log.info("[PoeTokenCapture] Listeners registered for Poe GraphQL requests");
}
