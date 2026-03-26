// Settings message handlers

import {
  clearOpenWebUIBaseUrl,
  getCliSettings,
  getOpenWebUIBaseUrl,
  regenerateCliApiKey,
  setCliEnabled,
  setCliPort,
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

// ─── CLI Integration ──────────────────────────────────────────────────────────

export async function handleGetCliSettings(
  _message: Extract<BackgroundRequest, { action: "getCliSettings" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const settings = await getCliSettings();
    sendResponse({ success: true, ...settings });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to get CLI settings",
    });
  }
}

export async function handleSetCliPort(
  message: Extract<BackgroundRequest, { action: "setCliPort" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await setCliPort(message.port);
    // Reapply bridge state with updated settings (lazy import to avoid circular deps).
    const { resetWsBridge } = await import("../wsBridge");
    await resetWsBridge();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to set CLI port",
    });
  }
}

export async function handleRegenerateCliApiKey(
  _message: Extract<BackgroundRequest, { action: "regenerateCliApiKey" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const apiKey = await regenerateCliApiKey();
    // Reapply bridge state so the new key is used for auth.
    const { resetWsBridge } = await import("../wsBridge");
    await resetWsBridge();
    sendResponse({ success: true, apiKey });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to regenerate CLI API key",
    });
  }
}

export async function handleSetCliEnabled(
  message: Extract<BackgroundRequest, { action: "setCliEnabled" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await setCliEnabled(message.enabled);
    const { applyWsBridgeSettings } = await import("../wsBridge");
    await applyWsBridgeSettings();
    sendResponse({ success: true });
  } catch (err: unknown) {
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to set CLI bridge state",
    });
  }
}
