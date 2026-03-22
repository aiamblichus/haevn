import type { BulkSyncConfig } from "../../providers/provider";
import { log } from "../../utils/logger";
import { navigateExtractionTab, pingTab } from "../utils/tabUtils";
import type { BulkSyncOptions } from "./types";

export interface FetchDataResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface FetchContext {
  tabId: number;
  chatId: string;
  url: string;
  baseUrl?: string;
  platformName: string;
  options: BulkSyncOptions;
}

export interface FetchStrategy {
  fetch(ctx: FetchContext): Promise<FetchDataResult>;
}

/**
 * API-based strategy (Fast path)
 * Uses provider's extractor.getChatData() via content script
 */
export class ApiFetchStrategy implements FetchStrategy {
  async fetch(ctx: FetchContext): Promise<FetchDataResult> {
    try {
      const { tabId, platformName, chatId, baseUrl } = ctx;

      // Use generic fetchConversation action with platformName parameter
      // This avoids needing special-case mappings for provider names
      const fetchResponse = await chrome.tabs.sendMessage(tabId, {
        action: "fetchConversation",
        platformName,
        chatId,
        baseUrl,
      });

      if (fetchResponse.success) {
        return { success: true, data: fetchResponse.data };
      } else {
        return { success: false, error: fetchResponse.error };
      }
    } catch (err: unknown) {
      log.error(
        `[Bulk Sync] Failed to fetch API conversation for ${ctx.platformName} ${ctx.chatId}:`,
        err,
      );
      return {
        success: false,
        error: err instanceof Error ? err.message : "Failed to fetch conversation",
      };
    }
  }
}

/**
 * Navigation-based strategy (Slow path)
 * Navigates to each chat URL and uses extractData() via content script
 */
export class NavigationFetchStrategy implements FetchStrategy {
  constructor(private config?: BulkSyncConfig) {}

  async fetch(ctx: FetchContext): Promise<FetchDataResult> {
    const { tabId, url, chatId, options } = ctx;
    const maxRetries = 2;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          log.info(`[Bulk Sync] Retry attempt ${attempt} for ${url} after error: ${lastError}`);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Always navigate to the chat URL before extracting
        log.info(`[Bulk Sync] Navigating to ${url} (attempt ${attempt + 1})`);
        await navigateExtractionTab(tabId, url);

        // Apply navigation delay if configured (for SPAs that need extra time)
        const navDelay = this.config?.navigationDelay;
        if (navDelay) {
          log.info(`[Bulk Sync] Applying ${navDelay}ms navigation delay`);
          await new Promise((resolve) => setTimeout(resolve, navDelay));
        }

        // Wait for content if configured (for lazy-loaded/virtualized content)
        if (this.config?.waitForContentReady) {
          log.info(`[Bulk Sync] Waiting for content to render for ${url}...`);
          try {
            const waitResult = await chrome.tabs.sendMessage(tabId, {
              action: "waitForReady",
              chatId,
            });
            if (!waitResult?.success) {
              log.error(`[Bulk Sync] Content wait failed: ${waitResult?.error || "unknown"}`);
              return {
                success: false,
                error: waitResult?.error || "Content did not load in time",
              };
            }
          } catch (waitErr) {
            log.warn(`[Bulk Sync] Failed to wait for content:`, waitErr);
            // Continue anyway for now, but log it
          }
        }

        // Verify content script is ready
        await pingTab(tabId);

        // Extract the data via content script
        const dataResponse = await chrome.tabs.sendMessage(tabId, {
          action: "extractData",
          options,
          chatId,
        });

        // If extraction succeeded, return success
        if (dataResponse?.success) {
          return dataResponse;
        }

        // Check if it's a retryable error
        const isTimeoutError =
          dataResponse?.error?.includes("Timeout") ||
          dataResponse?.error?.includes("timeout") ||
          dataResponse?.error?.includes("did not appear");

        if (!isTimeoutError && dataResponse) {
          return dataResponse;
        }

        // Retryable error
        if (attempt < maxRetries) {
          lastError = dataResponse?.error || "Extraction failed";
          continue;
        }

        return dataResponse || { success: false, error: "Extraction failed" };
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isTimeoutError =
          errorMessage.includes("Timeout") ||
          errorMessage.includes("timeout") ||
          errorMessage.includes("did not respond");

        if (!isTimeoutError || attempt >= maxRetries) {
          return {
            success: false,
            error: errorMessage,
          };
        }

        lastError = errorMessage;
      }
    }

    return {
      success: false,
      error: lastError || "Failed after multiple retry attempts",
    };
  }
}

/**
 * Factory function to get the appropriate strategy based on provider configuration
 */
export function getStrategy(config?: BulkSyncConfig): FetchStrategy {
  if (config?.mode === "api") {
    return new ApiFetchStrategy();
  }
  return new NavigationFetchStrategy(config);
}
