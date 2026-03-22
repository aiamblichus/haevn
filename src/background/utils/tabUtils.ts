// Tab utility functions for managing browser tabs

import { log } from "../../utils/logger";

export function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    (async () => {
      // Poll to check if tab is already loaded (handles race condition)
      for (let i = 0; i < 5; i++) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "complete" || tab.status === "loading") {
            // If complete, resolve immediately
            // If loading, wait a bit and check again (might be transitioning)
            if (tab.status === "complete") {
              resolve();
              return;
            }
            // If loading, wait a short time and check if it becomes complete
            await new Promise((r) => setTimeout(r, 100));
            const tabAgain = await chrome.tabs.get(tabId);
            if (tabAgain.status === "complete") {
              resolve();
              return;
            }
          }
        } catch (_err) {
          // Tab might not exist or be accessible
          reject(new Error(`Tab ${tabId} is not accessible`));
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      // Set up listener for status changes
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Timeout: Tab ${tabId} took too long to load.`));
        }
      }, 30000); // 30-second timeout

      const listener = (
        updatedTabId: number,
        changeInfo: { status?: string },
        _tab: chrome.tabs.Tab,
      ) => {
        if (resolved) return;

        // Use "interactive" instead of "complete" for faster navigation
        // "interactive" means DOM is ready, which is sufficient for content scripts
        // "complete" waits for all resources (images, etc.) which can be very slow
        if (updatedTabId === tabId && changeInfo.status === "interactive") {
          resolved = true;
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      // Also poll periodically as a fallback (in case event listener misses the event)
      const pollInterval = setInterval(async () => {
        if (resolved) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === "complete") {
            resolved = true;
            clearTimeout(timeout);
            clearInterval(pollInterval);
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        } catch (_err) {
          // Tab might not exist
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            clearInterval(pollInterval);
            chrome.tabs.onUpdated.removeListener(listener);
            reject(new Error(`Tab ${tabId} is not accessible`));
          }
        }
      }, 500); // Poll every 500ms
    })().catch(reject);
  });
}

export async function pingTab(tabId: number): Promise<void> {
  const maxRetries = 10;
  const retryDelay = 200; // ms

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { action: "ping" });
      if (response && response.status === "ready") {
        return;
      }
    } catch (_error) {
      log.info(`Ping attempt ${i + 1} for tab ${tabId} failed, retrying...`);
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  throw new Error(`Content script in tab ${tabId} did not respond to ping.`);
}

/**
 * Navigate a tab to a URL and ensure it's ready for content script interaction.
 *
 * DETERMINISTIC NAVIGATION SEQUENCE (Proposal 3):
 * This function implements a reliable, step-by-step navigation flow:
 * 1. Navigate: chrome.tabs.update() initiates navigation
 * 2. Wait: waitForTabLoad() waits for DOM ready ("interactive" status)
 * 3. Inject: chrome.scripting.executeScript() re-injects content script (idempotent)
 * 4. Verify: pingTab() confirms content script is alive and listening
 *
 * This sequence works WITH the browser's lifecycle instead of fighting against it,
 * ensuring reliable content script communication.
 */
export async function navigateTabToUrl(tabId: number, url: string): Promise<void> {
  // Check if we're already on this URL
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url === url && tab.status === "complete") {
      // Already on the target URL and loaded, just ensure content script is ready
      log.info(`[navigateTabToUrl] Tab ${tabId} already on ${url}, skipping navigation`);
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
        });
      } catch (_err) {
        // May already be injected, ignore
      }
      await pingTab(tabId);
      return;
    }

    // Wait for tab to be in a stable state before navigating
    // If tab is currently loading, wait for it to complete or timeout
    if (tab.status === "loading") {
      log.info(`[navigateTabToUrl] Tab ${tabId} is currently loading, waiting for stable state...`);
      try {
        await waitForTabLoad(tabId);
      } catch (err) {
        log.warn(
          `[navigateTabToUrl] Timeout waiting for tab to stabilize, proceeding anyway:`,
          err,
        );
      }
    }
  } catch (err) {
    log.warn(`[navigateTabToUrl] Could not check tab status:`, err);
  }

  // Small delay to ensure any pending navigations are complete
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Navigate to the URL
  try {
    await chrome.tabs.update(tabId, { url });
  } catch (navError: unknown) {
    const errorMsg = navError instanceof Error ? navError.message : String(navError);
    // If navigation was rejected, wait a bit and retry once
    if (errorMsg.includes("Navigation rejected") || errorMsg.includes("rejected")) {
      log.warn(`[navigateTabToUrl] Navigation rejected, waiting 500ms before retry...`);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if we're already on the target URL (navigation might have succeeded despite the error)
      try {
        const tab = await chrome.tabs.get(tabId);
        const normalizedUrl = url.split("?")[0].split("#")[0];
        const normalizedTabUrl = tab.url?.split("?")[0].split("#")[0];
        if (normalizedTabUrl === normalizedUrl) {
          log.info(
            `[navigateTabToUrl] Tab ${tabId} is already on target URL after retry delay, proceeding`,
          );
          // Navigation succeeded, but wait a bit to ensure page is fully loaded
          await new Promise((resolve) => setTimeout(resolve, 300));
          // Navigation succeeded, continue normally - don't throw
        } else {
          // Retry navigation
          try {
            await chrome.tabs.update(tabId, { url });
            // Retry succeeded, continue normally - don't throw
          } catch (_retryError: unknown) {
            // If retry also fails, throw the original error
            throw navError;
          }
        }
      } catch (_checkError) {
        // If we can't check tab status, try the retry anyway
        try {
          await chrome.tabs.update(tabId, { url });
          // Retry succeeded, continue normally - don't throw
        } catch (_retryError: unknown) {
          throw navError;
        }
      }
    } else {
      throw navError;
    }
  }

  await waitForTabLoad(tabId);

  // For Poe, wait for "complete" status instead of just "interactive"
  // Poe's SPA does client-side navigation that can destroy content script context
  // if we proceed too early
  const isPoeUrl = url.includes("poe.com");
  if (isPoeUrl) {
    log.info(`[navigateTabToUrl] Poe URL detected, waiting for complete status...`);
    let completeChecks = 0;
    const maxCompleteChecks = 20; // 4 seconds total
    for (let i = 0; i < maxCompleteChecks; i++) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          completeChecks++;
          // Need 2 consecutive complete checks to ensure stability
          if (completeChecks >= 2) {
            log.info(`[navigateTabToUrl] Poe page reached stable complete status`);
            break;
          }
        } else {
          completeChecks = 0;
        }
      } catch (err) {
        log.warn(`[navigateTabToUrl] Error checking tab status:`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Additional delay for Poe to ensure SPA has finished initializing
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_err) {
    // May already be injected, ignore
  }
  await pingTab(tabId);
}

/**
 * Create a new tab for extraction purposes.
 * Navigates to URL, waits for load, injects content script, and verifies readiness.
 * Returns the tab ID for later cleanup.
 */
export async function createExtractionTab(
  url: string,
  options?: { active?: boolean },
): Promise<number> {
  // Create new tab
  const tab = await chrome.tabs.create({
    url,
    active: options?.active ?? false, // Default to background tab
  });

  if (!tab.id) {
    throw new Error("Failed to create extraction tab");
  }

  const tabId = tab.id;

  // Wait for tab to load
  await waitForTabLoad(tabId);

  // For Poe, wait for complete status
  const isPoeUrl = url.includes("poe.com");
  if (isPoeUrl) {
    log.info(`[createExtractionTab] Poe URL detected, waiting for complete status...`);
    let completeChecks = 0;
    const maxCompleteChecks = 20; // 4 seconds total
    for (let i = 0; i < maxCompleteChecks; i++) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === "complete") {
          completeChecks++;
          if (completeChecks >= 2) {
            log.info(`[createExtractionTab] Poe page reached stable complete status`);
            break;
          }
        } else {
          completeChecks = 0;
        }
      } catch (err) {
        log.warn(`[createExtractionTab] Error checking tab status:`, err);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // Additional delay for Poe SPA initialization
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_err) {
    // May already be injected, ignore
  }

  // Verify content script is ready
  await pingTab(tabId);

  return tabId;
}

/**
 * Navigate an existing extraction tab to a new URL.
 * Useful for reusing a tab across multiple extractions.
 */
export async function navigateExtractionTab(tabId: number, url: string): Promise<void> {
  await navigateTabToUrl(tabId, url);
}
