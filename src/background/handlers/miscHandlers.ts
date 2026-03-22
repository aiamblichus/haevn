// Miscellaneous message handlers

import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";

export async function handleCloseTab(
  message: Extract<BackgroundRequest, { action: "closeTab" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const tabId: number = message.tabId;
    if (typeof tabId === "number") {
      try {
        await chrome.tabs.remove(tabId);
      } catch (err: unknown) {
        log.warn(`[MiscHandlers] Failed to remove tab ${tabId}:`, err);
      }
    }
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to close tab",
    });
  }
}

export async function handleReload(
  _message: Extract<BackgroundRequest, { action: "reload" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  log.info("[MiscHandlers] Reloading extension...");
  sendResponse({ success: true, message: "Reloading..." });
  setTimeout(() => chrome.runtime.reload(), 100);
}
