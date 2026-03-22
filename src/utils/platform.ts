// Platform Detection Utilities
import { getAllProviders } from "../providers/provider";

export type SupportedPlatform = string; // Relaxed to string to support any registered provider

export interface PlatformInfo {
  name: string;
  displayName: string;
  isSupported: boolean;
  canExportSingle: boolean;
  canExportBulk: boolean;
  bulkSyncRequiresActiveTab: boolean;
}

export function detectCurrentPlatform(): PlatformInfo {
  const providers = getAllProviders();
  const currentUrl = window.location.href;

  for (const provider of providers) {
    try {
      if (provider.extractor.isPlatform()) {
        const canSingle = !!provider.extractor.extractChatIdFromUrl(currentUrl);
        // Assume bulk supported if getChatIds is implemented
        const canBulk = !!provider.extractor.getChatIds;

        return {
          name: provider.name,
          displayName: provider.displayName,
          isSupported: true,
          canExportSingle: canSingle,
          canExportBulk: canBulk,
          bulkSyncRequiresActiveTab: !!provider.bulkSyncConfig?.requiresActiveTab,
        };
      }
    } catch (err) {
      // Ignore errors during detection
      console.debug(`Error checking platform ${provider.name}:`, err);
    }
  }

  // Unknown platform
  return {
    name: "unknown",
    displayName: "Unknown Platform",
    isSupported: false,
    canExportSingle: false,
    canExportBulk: false,
    bulkSyncRequiresActiveTab: false,
  };
}

export function isPlatformSupported(platformName: string): boolean {
  const platformInfo = detectCurrentPlatform();
  return platformInfo.name === platformName && platformInfo.isSupported;
}

export function isChatPage(): boolean {
  const providers = getAllProviders();
  const currentUrl = window.location.href;

  for (const provider of providers) {
    if (provider.extractor.isPlatform()) {
      return !!provider.extractor.extractChatIdFromUrl(currentUrl);
    }
  }
  return false;
}

export function getConversationId(): string | null {
  const providers = getAllProviders();
  const currentUrl = window.location.href;

  for (const provider of providers) {
    if (provider.extractor.isPlatform()) {
      return provider.extractor.extractChatIdFromUrl(currentUrl);
    }
  }
  return null;
}
