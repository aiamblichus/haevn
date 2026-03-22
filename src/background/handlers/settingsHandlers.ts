// Settings message handlers

import {
  clearOpenWebUIBaseUrl,
  getOpenWebUIBaseUrl,
  setOpenWebUIBaseUrl,
} from "../../services/settingsService";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";

export async function handleGetOpenWebUIBaseUrl(
  _message: Extract<BackgroundRequest, { action: "getOpenWebUIBaseUrl" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const baseUrl = await getOpenWebUIBaseUrl();
    sendResponse({ success: true, baseUrl });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get OpenWebUI base URL",
    });
  }
}

export async function handleSetOpenWebUIBaseUrl(
  message: Extract<BackgroundRequest, { action: "setOpenWebUIBaseUrl" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { baseUrl } = message;

    // Validate URL format
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        sendResponse({
          success: false,
          error: "Invalid URL format. Must be http:// or https://",
        });
        return;
      }
    } catch {
      sendResponse({
        success: false,
        error: "Invalid URL format. Must be http:// or https://",
      });
      return;
    }

    await setOpenWebUIBaseUrl(baseUrl);
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to set OpenWebUI base URL",
    });
  }
}

export async function handleClearOpenWebUIBaseUrl(
  _message: Extract<BackgroundRequest, { action: "clearOpenWebUIBaseUrl" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await clearOpenWebUIBaseUrl();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to clear OpenWebUI base URL",
    });
  }
}
