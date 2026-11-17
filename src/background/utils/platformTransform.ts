// Platform detection and transformer selection logic

import type { Chat } from "../../model/haevn_model";
import type { Provider } from "../../providers/provider";
import { getAllProviders } from "../../providers/provider";
import type { AllProviderRawData } from "../../types/messaging";

/**
 * Transforms raw platform data into HAEVN.Chat format based on platform detection
 * @param rawData Raw platform-specific data
 * @param platformName Platform name from content script detection (optional)
 * @param hostname Hostname from URL (used as fallback)
 * @param tabId Optional tab ID where the chat was extracted from (for media fetching)
 * @returns Array of Chat objects (some platforms like Poe can return multiple chats)
 */
export async function transformRawDataToHaevn(
  rawData: AllProviderRawData,
  platformName: string | undefined,
  hostname: string,
  tabId?: number,
): Promise<Chat[]> {
  // Get the provider based on platform name or hostname
  const provider = getProviderByPlatform(platformName, hostname);

  if (!provider) {
    throw new Error(`Unsupported platform for sync: ${hostname}`);
  }

  // Use the provider's transformer - type-safe, no casts needed
  // Cast to unknown first to satisfy interface compatibility if strict types differ
  // Pass tabId to transformer if it supports it
  return await provider.transformer.transform(rawData as unknown, tabId);
}

/**
 * Get the provider that handles a sync of this platform: the first registered provider, in
 * registration order, whose name is the platform name or whose hosts the hostname contains.
 * Import-only providers are never chosen. The registry is per JavaScript context, so each
 * context that transforms (service worker, content script, bulk sync worker) registers first.
 */
export function getProviderByPlatform(
  platformName: string | undefined,
  hostname: string,
): Provider | null {
  return (
    getAllProviders().find(
      (provider) =>
        !provider.importOnly &&
        (provider.name === platformName ||
          (provider.hosts ?? []).some((host) => hostname.includes(host))),
    ) ?? null
  );
}
