// Sync-related message handlers

import { getProvider } from "../../providers/provider";
import type {
  AllProviderRawData,
  BackgroundRequest,
  BackgroundResponse,
} from "../../types/messaging";
import { log } from "../../utils/logger";
import { handleBulkSync, resumeBulkSync as performResume } from "../bulkSync/bulkSync";
import { bulkSyncStateManager } from "../bulkSync/stateManager";
import { getBulkSyncState, cancelBulkSync as performCancel } from "../state";
import { transformAndSaveChat } from "../utils/chatSyncUtils";
import { pingTab, waitForTabLoad } from "../utils/tabUtils";
import { handleGenerateThumbnails } from "./galleryHandlers";

export async function handleStartBulkSync(
  message: Extract<BackgroundRequest, { action: "startBulkSync" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  // Check for incomplete sync BEFORE starting (Spec 03.02)
  const incompleteState = await bulkSyncStateManager.checkForIncompleteSync();
  if (incompleteState && incompleteState.provider === message.provider) {
    // Return special response for UI to show resume prompt
    sendResponse({
      success: false,
      canResume: true,
      incompleteState,
      error: `Found incomplete sync: ${incompleteState.processedChatIds.length}/${incompleteState.total} chats synced. Resume or start fresh?`,
      errorCode: "INCOMPLETE_SYNC_FOUND",
    });
    return;
  }

  // No incomplete sync, proceed normally
  // tabId is optional and only used for backward compatibility
  // The function uses a new extraction tab internally, so we can pass 0 as default
  handleBulkSync(message.tabId ?? 0, message.provider, message.baseUrl, message.options ?? {});
  sendResponse({ success: true });
}

export async function handleStartBulkSyncFromTab(
  message: Extract<BackgroundRequest, { action: "startBulkSyncFromTab" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const tabId: number = message.tabId;
    if (!tabId) throw new Error("Missing tabId");

    // Get current tab info
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) throw new Error("Tab has no URL");

    // Detect platform
    await pingTab(tabId);
    const detResponse = await chrome.tabs.sendMessage(tabId, {
      action: "detectPlatform",
    });
    if (!detResponse?.platform) {
      throw new Error("Could not detect platform");
    }

    const platformName = detResponse.platform.name;

    // Start bulk sync (no need to navigate current tab - extraction will use a new tab)
    handleBulkSync(tabId, platformName, message.baseUrl, message.options || {});
    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[startBulkSyncFromTab] error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to start bulk sync",
    });
  }
}

export async function handleCancelBulkSync(
  _message: Extract<BackgroundRequest, { action: "cancelBulkSync" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    await performCancel();
    sendResponse({ success: true });
  } catch (e: unknown) {
    sendResponse({
      success: false,
      error: e instanceof Error ? e.message : "Operation failed",
    });
  }
}

export async function handleGetBulkSyncState(
  _message: Extract<BackgroundRequest, { action: "getBulkSyncState" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const state = await getBulkSyncState();
    sendResponse({ success: true, state: state ?? undefined });
  } catch (e: unknown) {
    sendResponse({
      success: false,
      error: e instanceof Error ? e.message : "Operation failed",
    });
  }
}

export async function handleSyncChatByUrl(
  message: Extract<BackgroundRequest, { action: "syncChatByUrl" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const url: string = message.url;
    if (!url) throw new Error("Missing URL");
    const tempTab = await chrome.tabs.create({ url, active: false });
    if (!tempTab.id) throw new Error("Failed to create tab");

    await waitForTabLoad(tempTab.id);
    await chrome.scripting.executeScript({
      target: { tabId: tempTab.id },
      files: ["content.js"],
    });
    await pingTab(tempTab.id);

    const hostname = new URL(url).hostname;
    let platformName: string | undefined;
    try {
      const det = await chrome.tabs.sendMessage(tempTab.id, {
        action: "detectPlatform",
      });
      platformName = det?.platform?.name;
    } catch (err: unknown) {
      log.warn("[syncChatByUrl] Failed to detect platform:", err);
    }

    let raw: unknown;

    const provider = getProvider(platformName || "");
    const syncMode = provider?.bulkSyncConfig?.mode ?? "navigation";

    if (syncMode === "api") {
      log.info(`[syncChatByUrl] Using API-based fetching for ${platformName}`);

      const chatId = provider?.extractor?.extractChatIdFromUrl(url);
      if (!chatId) {
        throw new Error("Could not extract chat ID from URL");
      }

      const fetchResponse = await chrome.tabs.sendMessage(tempTab.id, {
        action: "fetchConversation",
        platformName,
        chatId,
      });

      if (!fetchResponse?.success) {
        throw new Error(fetchResponse?.error || "API fetch failed");
      }

      raw = fetchResponse.data;
    } else {
      // Use DOM-based extraction
      const dataResponse = await chrome.tabs.sendMessage(tempTab.id, {
        action: "extractData",
        options: {},
      });
      if (!dataResponse?.success) {
        throw new Error(dataResponse?.error || "Extraction failed");
      }

      raw = dataResponse.data;
      platformName = platformName || dataResponse.platform?.name;
    }

    const origin = new URL(url).origin;
    const savedIds = await transformAndSaveChat(
      raw as AllProviderRawData,
      platformName,
      hostname,
      origin,
      tempTab.id, // Pass tabId for media fetching
    );

    try {
      await chrome.tabs.remove(tempTab.id);
    } catch (err: unknown) {
      log.warn(`[syncChatByUrl] Failed to remove temp tab ${tempTab.id}:`, err);
    }

    sendResponse({
      success: true,
      chatId: savedIds.length > 0 ? savedIds[0] : undefined,
    });
  } catch (err: unknown) {
    log.error("[syncChatByUrl] error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Sync failed",
    });
  }
}

export async function handleSyncCurrentChat(
  message: Extract<BackgroundRequest, { action: "syncCurrentChat" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const tabId: number = message.tabId;
    const options = message.options || {};

    // Ensure content script is ready
    await pingTab(tabId);

    // Detect platform first
    const url = (await chrome.tabs.get(tabId)).url || "";
    const hostname = url ? new URL(url).hostname : "";

    let platformName: string | undefined;
    try {
      const det = await chrome.tabs.sendMessage(tabId, {
        action: "detectPlatform",
      });
      platformName = det?.platform?.name;
    } catch (err: unknown) {
      log.warn("[syncCurrentChat] Failed to detect platform:", err);
    }

    let raw: unknown;

    const provider = getProvider(platformName || "");
    const syncMode = provider?.bulkSyncConfig?.mode ?? "navigation";

    if (syncMode === "api") {
      log.info(`[syncCurrentChat] Using API-based fetching for ${platformName}`);

      const chatId = provider?.extractor?.extractChatIdFromUrl(url);
      if (!chatId) {
        throw new Error("Could not extract chat ID from URL");
      }

      const fetchResponse = await chrome.tabs.sendMessage(tabId, {
        action: "fetchConversation",
        platformName,
        chatId,
      });

      if (!fetchResponse?.success) {
        throw new Error(fetchResponse?.error || "API fetch failed");
      }

      raw = fetchResponse.data;
    } else {
      // Use DOM-based extraction
      const dataResponse = await chrome.tabs.sendMessage(tabId, {
        action: "extractData",
        options,
      });
      if (!dataResponse || !dataResponse.success) {
        throw new Error(dataResponse?.error || "Extraction failed");
      }

      raw = dataResponse.data;
      platformName = platformName || dataResponse.platform?.name;
    }

    let origin: string | undefined;
    if (platformName === "openwebui") {
      try {
        const tabInfo = await chrome.tabs.get(tabId);
        origin = tabInfo.url ? new URL(tabInfo.url).origin : undefined;
      } catch (err: unknown) {
        log.warn("[syncCurrentChat] Failed to get tab origin:", err);
      }
    }

    const savedIds = await transformAndSaveChat(
      raw as AllProviderRawData,
      platformName,
      hostname,
      origin,
      tabId, // Pass tabId for media fetching
    );

    // Generate thumbnails for saved chats (fire-and-forget)
    for (const chatId of savedIds) {
      handleGenerateThumbnails(chatId).catch((err) => {
        log.warn(`[syncCurrentChat] Failed to generate thumbnails for ${chatId}:`, err);
      });
    }

    sendResponse({
      success: true,
      chatId: savedIds.length > 0 ? savedIds[0] : undefined,
    });
  } catch (err: unknown) {
    log.error("[syncCurrentChat] error:", {
      error: err,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      type: typeof err,
      keys: err && typeof err === "object" ? Object.keys(err) : [],
    });
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Sync failed",
    });
  }
}

export async function handleResumeBulkSync(
  message: Extract<BackgroundRequest, { action: "resumeBulkSync" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { provider } = message;
    await performResume(provider);
    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[ResumeBulkSync] error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to resume sync",
    });
  }
}

export async function handleAbandonBulkSync(
  message: Extract<BackgroundRequest, { action: "abandonBulkSync" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    const { provider } = message;
    const state = await getBulkSyncState();

    // Verify state exists and matches provider
    if (!state || state.provider !== provider) {
      sendResponse({
        success: false,
        error: "No incomplete sync found for this provider",
        errorCode: "NO_INCOMPLETE_SYNC",
      });
      return;
    }

    log.info("[AbandonBulkSync] Abandoning incomplete sync", { provider });
    await bulkSyncStateManager.clearState();

    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[AbandonBulkSync] error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to abandon sync",
    });
  }
}

/**
 * Force resets the bulk sync state, clearing any stuck state.
 * This is a recovery mechanism for when sync gets stuck in STOPPING or other invalid states.
 */
export async function handleForceResetBulkSync(
  _message: Extract<BackgroundRequest, { action: "forceResetBulkSync" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  try {
    log.info("[ForceResetBulkSync] Force resetting bulk sync state");

    // Clear the bulk sync state
    await bulkSyncStateManager.clearState();

    // Also release operation lock in case it's held
    const { releaseOperationLock } = await import("../state");
    await releaseOperationLock("bulkSync");

    // Clear any pending alarms
    const { BULK_SYNC_ALARM_NAME } = await import("../bulkSync/bulkSync");
    chrome.alarms.clear(BULK_SYNC_ALARM_NAME);

    log.info("[ForceResetBulkSync] Bulk sync state reset complete");
    sendResponse({ success: true });
  } catch (err: unknown) {
    log.error("[ForceResetBulkSync] error:", err);
    sendResponse({
      success: false,
      error: err instanceof Error ? err.message : "Failed to force reset sync",
    });
  }
}
