// Utility functions for safe message passing

import type { BackgroundEvent } from "../../types/messaging";
import { log } from "../../utils/logger";

/**
 * Safely sends a message via chrome.runtime.sendMessage, handling cases where
 * no listener exists (e.g., options page is closed, background script is inactive).
 * This prevents "Could not establish connection. Receiving end does not exist." errors.
 *
 * @param message The message to send
 * @param options Optional callback or error handler
 * @returns Promise that resolves when message is sent (or silently fails if no listener)
 */
export function safeSendMessage(
  message: BackgroundEvent,
  options?: {
    onError?: (error: Error) => void;
  },
): void {
  try {
    chrome.runtime.sendMessage(message).catch((error: Error) => {
      // Handle the case where no listener exists (common with MV3 service workers)
      if (
        error.message?.includes("Could not establish connection") ||
        error.message?.includes("Receiving end does not exist")
      ) {
        // This is expected when UI components are closed - silently ignore
        log.debug(
          "[messageUtils] No listener for message:",
          message.action,
          "- this is normal if UI is closed",
        );
      } else {
        // Unexpected error - log it
        log.warn("[messageUtils] Error sending message:", error);
        if (options?.onError) {
          options.onError(error);
        }
      }
    });
  } catch (err) {
    // Synchronous error (shouldn't happen, but handle it anyway)
    log.warn("[messageUtils] Synchronous error sending message:", err);
    if (options?.onError && err instanceof Error) {
      options.onError(err);
    }
  }
}
