// src/background/health/chromeProbe.ts
//
// The browser side of providerHealth: the same tab, content-script and fetch-strategy code a bulk
// sync uses, so what is checked is what bulk sync runs. Nothing here saves, queues or indexes.

import type { Provider } from "../../providers/provider";
import { getOpenWebUIBaseUrl } from "../../services/settingsService";
import { getStrategy } from "../bulkSync/fetchStrategies";
import { createExtractionTab } from "../utils/tabUtils";
import {
  type FetchedChat,
  type HealthDeps,
  type HealthProbe,
  ProbeOpenError,
} from "./providerHealth";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const chromeProbe: HealthProbe = {
  async open(url, foreground, onTab) {
    let created: number | undefined;
    try {
      return await createExtractionTab(url, {
        active: foreground,
        onCreated: (id) => {
          created = id;
          onTab(id);
        },
      });
    } catch (err) {
      // The tab's address says what the failure was (an error page, a sign-in page); read it
      // before the caller closes the tab.
      const address = created === undefined ? undefined : await chromeProbe.tabUrl(created);
      throw new ProbeOpenError(message(err), address);
    }
  },

  async tabUrl(tabId) {
    try {
      return (await chrome.tabs.get(tabId)).url;
    } catch {
      return undefined;
    }
  },

  async listIds(tabId) {
    const response = await chrome.tabs.sendMessage(tabId, { action: "getChatIds" });
    if (!response?.success || !Array.isArray(response.chatIds)) {
      throw new Error(response?.error || "Failed to get chat IDs from the page.");
    }
    return response.chatIds as string[];
  },

  async fetchChat(tabId, provider: Provider, chatId, baseUrl): Promise<FetchedChat> {
    const result = await getStrategy(provider.bulkSyncConfig).fetch({
      tabId,
      chatId,
      url: provider.buildChatUrl(chatId, baseUrl),
      baseUrl,
      platformName: provider.name,
      options: {},
    });
    return { success: result.success, data: result.data, error: result.error };
  },

  async close(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Already gone (the user closed it, or the browser did).
    }
  },
};

/** The dependencies of the real run: the browser, the settings, the clock. */
export function chromeHealthDeps(): HealthDeps {
  return {
    probe: chromeProbe,
    openWebUIBaseUrl: getOpenWebUIBaseUrl,
    extensionVersion: () => chrome.runtime.getManifest().version || "unknown",
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
