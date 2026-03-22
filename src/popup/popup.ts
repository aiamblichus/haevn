import type { BulkSyncState } from "../background/bulkSync/types";
import type { Chat } from "../model/haevn_model";
import { log } from "../utils/logger";

log.info("HAEVN Popup loaded");

interface TabInfo {
  id?: number;
  url?: string;
}

interface PlatformInfo {
  name: string;
  displayName: string;
  isSupported: boolean;
  canExportSingle: boolean;
  canExportBulk: boolean;
}

// No export options in popup; sync-only UI

// DOM Elements
let platformIcon: HTMLElement;
let platformName: HTMLElement;
let platformUrl: HTMLElement;
let exportSingleBtn: HTMLButtonElement;
let exportBtn: HTMLButtonElement;
let exportAllBtn: HTMLButtonElement;
let syncAllBtn: HTMLButtonElement;
let manageSyncedChatsBtn: HTMLButtonElement | null;
let unsupportedPlatformMessage: HTMLElement | null;
let overwriteExistingCheckbox: HTMLInputElement;
let syncIndicator: HTMLElement | null;
let syncIndicatorDot: HTMLElement | null;
let syncIndicatorText: HTMLElement | null;
let syncActionsSection: HTMLElement | null;
let exportSection: HTMLElement | null;
let archiveLoadingIndicator: HTMLElement | null;

let currentTab: TabInfo = {};
let currentPlatform: PlatformInfo | null = null;
let isBulkSyncing = false;
let isSingleSyncing = false;
let currentChatId: string | null = null;
let isCurrentChatSynced = false;
let hasCheckedSyncStatus = false;
let isInitializing = true;
// Global sync state for bulk sync progress view
let globalSyncState: BulkSyncState | null = null;

document.addEventListener("DOMContentLoaded", async () => {
  initializeElements();
  // Show loading indicator initially
  updateArchiveButtonVisibility();
  // Disable all buttons initially (after elements are initialized)
  disableAllButtons();
  await initializePopup();
  setupEventListeners();
});

function initializeElements(): void {
  platformIcon = document.getElementById("platform-icon") as HTMLElement;
  platformName = document.getElementById("platform-name") as HTMLElement;
  platformUrl = document.getElementById("platform-url") as HTMLElement;
  exportSingleBtn = document.getElementById("exportSingleBtn") as HTMLButtonElement;
  exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
  exportAllBtn = document.getElementById("exportAllBtn") as HTMLButtonElement;
  syncAllBtn = document.getElementById("syncAllBtn") as HTMLButtonElement;
  manageSyncedChatsBtn = document.getElementById(
    "manageSyncedChatsBtn",
  ) as HTMLButtonElement | null;
  unsupportedPlatformMessage = document.getElementById("unsupported-platform-message");
  overwriteExistingCheckbox = document.getElementById(
    "overwriteExistingCheckbox",
  ) as HTMLInputElement;
  syncIndicator = document.getElementById("syncIndicator");
  syncIndicatorDot = document.getElementById("syncIndicatorDot");
  syncIndicatorText = document.getElementById("syncIndicatorText");
  syncActionsSection = document.getElementById("syncActionsSection");
  exportSection = document.getElementById("exportSection");
  archiveLoadingIndicator = document.getElementById("archiveLoadingIndicator");
}

function getSyncProgressSection(): HTMLElement | null {
  return document.getElementById("syncProgressSection");
}

function getProgressBar(): HTMLElement | null {
  return document.getElementById("progress-bar");
}

function getProgressText(): HTMLElement | null {
  return document.getElementById("progress-text");
}

function getStopSyncBtn(): HTMLButtonElement | null {
  return document.getElementById("stopSyncBtn") as HTMLButtonElement | null;
}

async function initializePopup(): Promise<void> {
  try {
    // First, check for a global sync state
    try {
      const res = await chrome.runtime.sendMessage({
        action: "getBulkSyncState",
      });
      if (res.success && res.state) {
        globalSyncState = res.state;
      }
    } catch (e) {
      log.warn("Could not poll for bulk sync state", e);
    }

    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    currentTab = { id: tab.id, url: tab.url };

    if (!tab.id || !tab.url) {
      showError("Could not get active tab information.");
      isInitializing = false;
      updateButtonStates();
      updateArchiveButtonVisibility();
      updatePopupView();
      return;
    }

    platformUrl.textContent = tab.url;

    // Try to detect platform, but don't treat unsupported platforms as errors
    try {
      // Wait for content script to be ready
      await waitForContentScript(tab.id);

      // Now, detect the platform
      const platformResponse = await chrome.tabs.sendMessage(tab.id, {
        action: "detectPlatform",
      });
      if (platformResponse?.platform) {
        currentPlatform = platformResponse.platform;
        updatePlatformUI(platformResponse.platform);

        // Get conversation ID directly from content script (fast path)
        if (currentPlatform?.isSupported && currentTab.id) {
          try {
            const convIdResponse = await chrome.tabs.sendMessage(tab.id, {
              action: "getConversationId",
            });
            const conversationId = convIdResponse?.conversationId;

            // Check if current chat is synced using optimized path
            if (conversationId) {
              await checkCurrentChatSynced(currentPlatform.name, conversationId);
            } else {
              // No conversation ID found, mark as not synced
              hasCheckedSyncStatus = true;
              isCurrentChatSynced = false;
              currentChatId = null;
              updateButtonStates();
              updateSyncIndicator();
            }
          } catch (error) {
            log.error("Error getting conversation ID", error);
            hasCheckedSyncStatus = true;
            isCurrentChatSynced = false;
            currentChatId = null;
            updateButtonStates();
            updateSyncIndicator();
          }
        } else {
          // Platform not supported, initialization complete
          hasCheckedSyncStatus = true;
          updateButtonStates();
          updateArchiveButtonVisibility();
        }
      } else {
        // Platform not detected - treat as unsupported, not an error
        showUnsupportedPlatform();
        hasCheckedSyncStatus = true;
        updateButtonStates();
        updateArchiveButtonVisibility();
      }
    } catch (error: unknown) {
      // Content script injection/message failure on unsupported sites is normal
      // Only show error if it's a real error (e.g., can't access tab)
      log.debug("Platform detection not available (unsupported site)", error);
      showUnsupportedPlatform();
      hasCheckedSyncStatus = true;
      updateButtonStates();
      updateArchiveButtonVisibility();
    }
  } catch (error: unknown) {
    // Only show error for actual failures (e.g., can't get tab info)
    log.error("Error initializing popup", error);
    showError("Could not get tab information. Please refresh the tab and try again.");
    hasCheckedSyncStatus = true;
    updateButtonStates();
    updateArchiveButtonVisibility();
  } finally {
    isInitializing = false;
    updateButtonStates();
    updateArchiveButtonVisibility();
    // Crucially, update the entire UI based on whether a sync is active
    updatePopupView();
  }
}

function updatePopupView(): void {
  // Is a sync running for the *current* platform?
  const isSyncingThisProvider =
    globalSyncState?.status === "running" && globalSyncState?.provider === currentPlatform?.name;

  const syncProgressSection = getSyncProgressSection();
  const progressBar = getProgressBar();
  const progressText = getProgressText();

  if (isSyncingThisProvider) {
    // Show progress view
    if (syncProgressSection) {
      syncProgressSection.classList.remove("hidden");
    }
    if (syncActionsSection) {
      syncActionsSection.classList.add("hidden");
    }
    if (exportSection) {
      exportSection.classList.add("hidden");
    }

    const progress = globalSyncState
      ? (globalSyncState.currentIndex / globalSyncState.total) * 100
      : 0;
    if (progressBar) {
      progressBar.style.width = `${progress}%`;
    }
    if (progressText && globalSyncState) {
      progressText.textContent = `Syncing ${globalSyncState.currentIndex} / ${globalSyncState.total}...`;
      const stopBtn = getStopSyncBtn();
      if (stopBtn) {
        stopBtn.disabled = false;
        const span = stopBtn.querySelector("span");
        if (span) span.textContent = "STOP SYNC";
      }
    }
  } else {
    // Show normal view
    if (syncProgressSection) {
      syncProgressSection.classList.add("hidden");
    }
    if (currentPlatform?.isSupported) {
      if (syncActionsSection) {
        syncActionsSection.classList.remove("hidden");
      }
      if (exportSection) {
        exportSection.classList.remove("hidden");
      }
    }
  }

  updateButtonStates(); // Re-run this to disable buttons if progress is showing or sync is active
}

async function waitForContentScript(tabId: number): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 200; // ms

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
      if (response && response.status === "ready") {
        log.debug("Content script is ready");
        return;
      }
    } catch {
      // This error is expected if the content script is not yet injected
      log.debug(`Attempt ${i + 1}: Content script not ready, retrying...`);
      // Try injecting content.js using activeTab permission when popup is open
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
      } catch {
        // ignore and retry ping
      }
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  throw new Error("Content script did not respond.");
}

function updatePlatformUI(platform: PlatformInfo): void {
  // Clear any existing content
  platformIcon.innerHTML = "";
  platformIcon.className = "w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden";

  // Handle unknown platform with fallback
  if (platform.name === "unknown") {
    platformIcon.innerHTML = '<span class="text-lg">❓</span>';
  } else {
    const img = document.createElement("img");
    img.src = chrome.runtime.getURL(`icons/${platform.name}.png`);
    img.alt = platform.displayName;
    img.className = "w-full h-full object-contain";
    platformIcon.appendChild(img);
  }

  platformName.textContent = platform.displayName;

  // Hide unsupported platform message when a platform is detected
  if (unsupportedPlatformMessage) {
    unsupportedPlatformMessage.classList.add("hidden");
  }

  if (platform.isSupported) {
    updateStatus("Ready to sync", "success");
    // Show sync and export sections for supported platforms
    if (syncActionsSection) {
      syncActionsSection.classList.remove("hidden");
    }
    if (exportSection) {
      exportSection.classList.remove("hidden");
    }
  } else {
    updateStatus("Platform not yet supported", "warning");
    // Hide sync and export sections for unsupported platforms
    if (syncActionsSection) {
      syncActionsSection.classList.add("hidden");
    }
    if (exportSection) {
      exportSection.classList.add("hidden");
    }
  }

  // Show/hide Sync All button based on platform support
  if (platform.canExportBulk && syncAllBtn) {
    syncAllBtn.classList.remove("hidden");
  } else if (syncAllBtn) {
    syncAllBtn.classList.add("hidden");
  }

  // Don't update sync indicator here - wait until we've checked the sync status
}

function showUnsupportedPlatform(): void {
  platformIcon.innerHTML = "";
  platformIcon.className = "w-8 h-8 rounded-lg flex items-center justify-center overflow-hidden";
  // Use a fallback emoji for unknown platforms since we don't have a question.png icon
  platformIcon.innerHTML = '<span class="text-lg">🌐</span>';
  platformName.textContent = "Unsupported Website";
  updateStatus("To sync chats, visit a supported website", "info");

  // Show the informational message about supported platforms
  if (unsupportedPlatformMessage) {
    unsupportedPlatformMessage.classList.remove("hidden");
  }

  // Hide sync and export sections for unsupported platforms
  if (syncActionsSection) {
    syncActionsSection.classList.add("hidden");
  }
  if (exportSection) {
    exportSection.classList.add("hidden");
  }

  updateButtonStates();
}

function updateArchiveButtonVisibility(): void {
  if (archiveLoadingIndicator && manageSyncedChatsBtn) {
    if (isInitializing) {
      // Show loading indicator, hide button
      archiveLoadingIndicator.classList.remove("hidden");
      manageSyncedChatsBtn.classList.add("hidden");
    } else {
      // Hide loading indicator, show button
      archiveLoadingIndicator.classList.add("hidden");
      manageSyncedChatsBtn.classList.remove("hidden");
    }
  }
}

function disableAllButtons(): void {
  exportSingleBtn.disabled = true;
  exportBtn.disabled = true;
  exportAllBtn.disabled = true;
  syncAllBtn.disabled = true;
  if (manageSyncedChatsBtn) {
    manageSyncedChatsBtn.disabled = true;
  }
}

function updateButtonStates(): void {
  // Keep buttons disabled until initialization completes
  if (isInitializing || !hasCheckedSyncStatus) {
    disableAllButtons();
    return;
  }

  // Check if any sync is in progress (single or bulk)
  const isSyncing = isSingleSyncing || isBulkSyncing;
  // Also check if a global bulk sync is running for this provider
  const isGlobalBulkSyncing =
    globalSyncState?.status === "running" && globalSyncState?.provider === currentPlatform?.name;

  const canExportSingle = currentPlatform?.canExportSingle ?? false;
  // Disable sync button if syncing or if platform doesn't support single sync
  exportSingleBtn.disabled = !canExportSingle || isSyncing || isGlobalBulkSyncing;
  const span = exportSingleBtn.querySelector("span");
  if (span) {
    span.textContent = "Sync";
  }

  // Enable Export button only if chat is synced
  exportBtn.disabled = !isCurrentChatSynced || !currentChatId;

  // Enable Export All button only if platform is supported
  exportAllBtn.disabled = !currentPlatform?.isSupported;

  // Disable Sync All button if syncing or if platform doesn't support bulk sync
  syncAllBtn.disabled = !currentPlatform?.canExportBulk || isSyncing || isGlobalBulkSyncing;

  // Disable overwrite checkbox while syncing
  if (overwriteExistingCheckbox) {
    overwriteExistingCheckbox.disabled = isSyncing || isGlobalBulkSyncing;
  }

  // Enable Archive button after initialization
  if (manageSyncedChatsBtn) {
    manageSyncedChatsBtn.disabled = false;
  }
}

async function checkCurrentChatSynced(
  platformName?: string,
  conversationId?: string,
): Promise<void> {
  if (!currentTab.id) return;

  try {
    // Use optimized path: pass platformName and conversationId directly
    const response = await chrome.runtime.sendMessage({
      action: "checkCurrentChatSynced",
      tabId: currentTab.id,
      platformName: platformName,
      conversationId: conversationId,
    });

    if (response?.success) {
      isCurrentChatSynced = response.synced || false;
      currentChatId = response.chatId || null;
      hasCheckedSyncStatus = true;
      updateButtonStates();
      updateSyncIndicator();
    }
  } catch (error: unknown) {
    log.error("Error checking sync status", error);
    isCurrentChatSynced = false;
    currentChatId = null;
    hasCheckedSyncStatus = true;
    updateButtonStates();
    updateSyncIndicator();
  }
}

function setupEventListeners(): void {
  exportSingleBtn.addEventListener("click", handleSingleExport);
  exportBtn.addEventListener("click", handleExport);
  exportAllBtn.addEventListener("click", handleExportAll);
  syncAllBtn.addEventListener("click", confirmActiveTabThenSync);
  manageSyncedChatsBtn?.addEventListener("click", () => chrome.runtime.openOptionsPage());

  const stopSyncBtn = getStopSyncBtn();
  if (stopSyncBtn) {
    stopSyncBtn.addEventListener("click", async () => {
      // Immediate UI feedback
      stopSyncBtn.disabled = true;
      const span = stopSyncBtn.querySelector("span");
      if (span) span.textContent = "STOPPING...";
      const progressText = getProgressText();
      if (progressText) progressText.textContent = "Requesting cancellation...";

      try {
        await chrome.runtime.sendMessage({ action: "cancelBulkSync" });
      } catch (err) {
        log.error("Failed to send cancelBulkSync message", err);
        stopSyncBtn.disabled = false;
        if (span) span.textContent = "STOP SYNC";
      }
    });
  }

  // Listen for bulk sync progress updates
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.action === "bulkSyncProgress") {
      // Show progress immediately, even before state is set
      const isSyncingThisProvider = message.provider === currentPlatform?.name;

      if (isSyncingThisProvider) {
        // Show progress view
        const syncProgressSection = getSyncProgressSection();
        const progressBar = getProgressBar();
        const progressText = getProgressText();

        if (syncProgressSection) {
          syncProgressSection.classList.remove("hidden");
        }
        if (syncActionsSection) {
          syncActionsSection.classList.add("hidden");
        }
        if (exportSection) {
          exportSection.classList.add("hidden");
        }

        const progress = message.progress || 0;
        if (progressBar) {
          progressBar.style.width = `${progress}%`;
        }
        if (progressText) {
          progressText.textContent = message.status || "Syncing...";
        }
      }

      // Also update state for consistency
      try {
        const res = await chrome.runtime.sendMessage({
          action: "getBulkSyncState",
        });
        if (res.success) {
          globalSyncState = res.state;
        }
      } catch (e) {
        log.warn("Could not get bulk sync state", e);
      }
    } else if (message.action?.startsWith("bulkSync")) {
      // Re-fetch the global state and update the view
      try {
        const res = await chrome.runtime.sendMessage({
          action: "getBulkSyncState",
        });
        if (res.success) {
          globalSyncState = res.state;
          // Reset local bulk syncing flag if sync is no longer running
          if (isBulkSyncing && (!globalSyncState || globalSyncState.status !== "running")) {
            isBulkSyncing = false;
          }
          updatePopupView(); // Redraw the entire popup UI
          updateButtonStates(); // Update button states based on new sync state
        }
      } catch (e) {
        log.warn("Could not get bulk sync state", e);
      }
    } else if (message.action === "chatSynced") {
      // Update sync status when a chat is synced
      // Re-check sync status to see if it's the current chat
      // Use optimized path if we have platform info
      if (currentPlatform?.name && currentTab.id) {
        try {
          const convIdResponse = await chrome.tabs.sendMessage(currentTab.id, {
            action: "getConversationId",
          });
          const conversationId = convIdResponse?.conversationId;
          if (conversationId) {
            await checkCurrentChatSynced(currentPlatform.name, conversationId);
          } else {
            await checkCurrentChatSynced();
          }
        } catch {
          await checkCurrentChatSynced();
        }
      } else {
        await checkCurrentChatSynced();
      }
    }
  });
}

async function handleSingleExport(): Promise<void> {
  if (!currentTab.id || !currentPlatform?.canExportSingle) return;

  try {
    isSingleSyncing = true;
    updateButtonStates();
    updateSyncIndicator();
    updateStatus("Syncing conversation...", "working");
    showProgress(0);

    const response = await chrome.runtime.sendMessage({
      action: "syncCurrentChat",
      tabId: currentTab.id,
    });

    if (response?.success) {
      showProgress(100);
      updateStatus("Synced!", "success");

      // Update sync status - re-check to ensure we have the correct chatId
      if (currentPlatform?.name && currentTab.id) {
        try {
          const convIdResponse = await chrome.tabs.sendMessage(currentTab.id, {
            action: "getConversationId",
          });
          const conversationId = convIdResponse?.conversationId;
          if (conversationId) {
            await checkCurrentChatSynced(currentPlatform.name, conversationId);
          } else {
            await checkCurrentChatSynced();
          }
        } catch {
          await checkCurrentChatSynced();
        }
      } else {
        await checkCurrentChatSynced();
      }

      setTimeout(() => {
        hideProgress();
        updateStatus("Ready to sync", "success");
      }, 2000);
    } else {
      throw new Error(response?.error || "Sync failed");
    }
  } catch (error: unknown) {
    log.error("Sync failed", {
      error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    updateStatus("Sync failed", "error");
    hideProgress();
  } finally {
    isSingleSyncing = false;
    updateButtonStates();
    updateSyncIndicator();
  }
}

async function handleExport(): Promise<void> {
  if (!currentChatId || !isCurrentChatSynced) return;

  try {
    updateStatus("Exporting...", "working");
    const response = await chrome.runtime.sendMessage({
      action: "exportSyncedChat",
      chatId: currentChatId,
      options: {
        format: "json",
        includeMetadata: true,
        includeTimestamps: true,
      },
    });

    if (response?.success) {
      updateStatus("Exported!", "success");
      setTimeout(() => {
        updateStatus("Ready to sync", "success");
      }, 2000);
    } else {
      throw new Error(response?.error || "Export failed");
    }
  } catch (error: unknown) {
    log.error("Export failed", error);
    updateStatus("Export failed", "error");
    setTimeout(() => {
      updateStatus("Ready to sync", "success");
    }, 2000);
  }
}

async function handleExportAll(): Promise<void> {
  if (!currentPlatform?.isSupported || !currentPlatform.name) return;

  try {
    updateStatus("Preparing export...", "working");
    showProgress(0);

    // Get all synced chats metadata
    const metadataResponse = await chrome.runtime.sendMessage({
      action: "getSyncedChatsMetadata",
    });

    if (!metadataResponse?.success) {
      throw new Error(metadataResponse?.error || "Failed to get chat metadata");
    }

    const allChats = metadataResponse.data || [];

    // Filter chats by current provider
    const providerName = currentPlatform.name.toLowerCase();
    const filteredChats = (allChats as Chat[]).filter((chat) => {
      const source = (chat.source || "").toLowerCase();
      return source.includes(providerName);
    });

    if (filteredChats.length === 0) {
      updateStatus("No chats to export", "warning");
      hideProgress();
      setTimeout(() => {
        updateStatus("Ready to sync", "success");
      }, 2000);
      return;
    }

    const chatIds = filteredChats.map((chat) => chat.id);

    // Get export options - use selected format from dropdown, fallback to storage
    const exportOptions = {
      format: "json",
      includeMetadata: true,
      includeTimestamps: true,
    };

    updateStatus(`Exporting ${chatIds.length} chats...`, "working");

    // Call bulk export handler
    const response = await chrome.runtime.sendMessage({
      action: "startBulkExport",
      chatIds,
      options: exportOptions,
    });

    if (response?.success) {
      showProgress(100);
      updateStatus("Export started. Processing batches...", "success");
      setTimeout(() => {
        hideProgress();
        updateStatus("Ready to sync", "success");
      }, 3000);
    } else {
      throw new Error(response?.error || "Export failed to start");
    }
  } catch (error) {
    log.error("Export All failed", error);
    updateStatus("Export failed", "error");
    hideProgress();
    setTimeout(() => {
      updateStatus("Ready to sync", "success");
    }, 2000);
  }
}

function confirmActiveTabThenSync(): void {
  if (currentPlatform?.bulkSyncRequiresActiveTab) {
    const dialog = document.getElementById("activeTabConfirmDialog");
    const msg = document.getElementById("activeTabConfirmMessage");
    const cancelBtn = document.getElementById("activeTabConfirmCancel");
    const proceedBtn = document.getElementById("activeTabConfirmProceed");
    if (!dialog || !msg || !cancelBtn || !proceedBtn) {
      handleBulkSync();
      return;
    }
    msg.textContent = `${currentPlatform.displayName} uses live page rendering to extract conversations. Keep the sync tab visible while the sync runs — switching away or minimising the window will cause it to stall.`;
    dialog.classList.remove("hidden");
    const close = () => dialog.classList.add("hidden");
    cancelBtn.onclick = close;
    proceedBtn.onclick = () => {
      close();
      handleBulkSync();
    };
  } else {
    handleBulkSync();
  }
}

async function handleBulkSync(): Promise<void> {
  if (!currentTab.id || !currentPlatform?.canExportBulk || isBulkSyncing) return;

  try {
    updateStatus("Starting bulk sync...", "working");
    showProgress(0);
    isBulkSyncing = true;
    updateButtonStates();
    updateSyncIndicator();

    const overwriteExisting = overwriteExistingCheckbox.checked;

    // For Open WebUI, we need to fetch the configured base URL
    // TODO: we need to rethink this, this should be handled by the provider
    let baseUrl: string | undefined;
    if (currentPlatform.name === "openwebui") {
      try {
        const urlResponse = await chrome.runtime.sendMessage({
          action: "getOpenWebUIBaseUrl",
        });
        if (urlResponse?.success && urlResponse.baseUrl) {
          baseUrl = urlResponse.baseUrl;
        } else {
          throw new Error("Open WebUI base URL not configured. Please set it in Settings.");
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("not configured")) {
          throw err;
        }
        throw new Error("Failed to get Open WebUI base URL. Please configure it in Settings.");
      }
    }

    const response = await chrome.runtime.sendMessage({
      action: "startBulkSyncFromTab",
      tabId: currentTab.id,
      baseUrl,
      options: {
        overwriteExisting,
      },
    });

    if (!response || !response.success) {
      throw new Error(response?.error || "Failed to start bulk sync");
    }

    // Don't close popup immediately - let user see the progress
    // The popup will show the global progress view when sync is active
  } catch (error: unknown) {
    log.error("Bulk sync failed", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to start sync";
    updateStatus(errorMessage, "error");
    hideProgress();
    isBulkSyncing = false;
    updateButtonStates();
    updateSyncIndicator();
  }
}

function updateSyncIndicator(): void {
  if (!syncIndicator || !syncIndicatorDot || !syncIndicatorText) return;

  // Only show indicator if platform is supported
  if (!currentPlatform?.isSupported) {
    syncIndicator.classList.add("hidden");
    return;
  }

  // Don't show indicator until we've checked the sync status
  if (!hasCheckedSyncStatus) {
    syncIndicator.classList.add("hidden");
    return;
  }

  const isSyncing = isSingleSyncing || isBulkSyncing;

  if (isSyncing) {
    // SYNCING state - yellow/secondary color with pulse
    syncIndicator.classList.remove("hidden");
    syncIndicatorDot.className = "w-2 h-2 rounded-full bg-[hsl(var(--secondary))] animate-pulse";
    syncIndicatorText.textContent = "SYNCING";
    syncIndicatorText.className =
      "text-xs text-[hsl(var(--secondary))] uppercase tracking-wider font-bold";
  } else if (isCurrentChatSynced) {
    // SYNCED state - green
    syncIndicator.classList.remove("hidden");
    syncIndicatorDot.className = "w-2 h-2 rounded-full bg-green-500";
    syncIndicatorText.textContent = "SYNCED";
    syncIndicatorText.className = "text-xs text-green-500 uppercase tracking-wider font-bold";
  } else {
    // UNSYNCED state - red
    syncIndicator.classList.remove("hidden");
    syncIndicatorDot.className = "w-2 h-2 rounded-full bg-[hsl(var(--destructive))]";
    syncIndicatorText.textContent = "UNSYNCED";
    syncIndicatorText.className =
      "text-xs text-[hsl(var(--destructive))] uppercase tracking-wider font-bold";
  }
}

// Bulk export and export options removed from popup UI

function updateStatus(_message?: string, _type?: string): void {
  // Status display removed - function kept for compatibility but does nothing
}

function showProgress(_progress?: number, _message?: string): void {
  // Progress display removed - function kept for compatibility but does nothing
}

function hideProgress(): void {
  // Progress display removed - function kept for compatibility but does nothing
}

function showError(message: string): void {
  updateStatus(message, "error");
  platformUrl.textContent = "Error loading page information";
}
