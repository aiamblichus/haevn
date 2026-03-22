// Provider Abstraction Layer

import type { Extractor, Importer, Transformer } from "./interfaces";

export interface ProviderAvailabilityResult {
  available: boolean;
  count?: number;
  tabId?: number;
  reason?: string;
}

/**
 * Sync mode determines how bulk sync fetches individual chats.
 * - 'api': Fast, background fetch via provider API (Claude, ChatGPT, etc.)
 * - 'navigation': Requires tab navigation and DOM extraction (Gemini, AI Studio)
 */
export type SyncMode = "api" | "navigation";

/**
 * Bulk sync configuration for a provider.
 * Encapsulates all provider-specific sync behaviors so bulkSync.ts
 * can remain completely provider-agnostic.
 */
export interface BulkSyncConfig {
  /**
   * How this provider fetches individual chat data during bulk sync.
   * - 'api': Uses extractor.getChatData() - fast, no navigation
   * - 'navigation': Navigates to each chat URL and uses extractData() - slower, DOM-based
   *
   * Default: 'navigation' (safest fallback)
   */
  mode: SyncMode;

  /**
   * Delay (ms) after tab navigation before attempting extraction.
   * Only applicable when mode is 'navigation'.
   * Used for SPAs that need extra time for client-side routing.
   *
   * Example: Poe (SPA) needs 1500ms for navigation to complete.
   */
  navigationDelay?: number;

  /**
   * If true, call extractor.waitForReady() before extraction.
   * Only applicable when mode is 'navigation'.
   * Used for platforms with virtualized/lazy-loaded content.
   *
   * Example: AI Studio uses virtualized rendering that needs explicit wait.
   */
  waitForContentReady?: boolean;

  /**
   * Delay between chat fetches in milliseconds (rate limiting).
   * Default: 200ms for API-based providers, 1000ms for navigation-based
   * Override for providers with stricter rate limits (e.g., Poe: 2000ms)
   */
  rateLimitDelayMs?: number;

  /**
   * If true, the extraction tab must be active (foreground) during bulk sync.
   * Required for platforms whose virtualised renderers depend on viewport
   * visibility to hydrate DOM content (e.g. AI Studio, Gemini).
   * When false (default), the tab runs hidden in the background.
   */
  requiresActiveTab?: boolean;
}

/**
 * Provider Interface
 * Complete provider definition with metadata, extractor, transformer, and optional importer
 * @template TRaw - Provider-specific raw data type
 * @template TImport - Import file data type
 */
export interface Provider<TRaw = unknown, TImport = unknown> {
  // Metadata
  name: string;
  displayName: string;

  // Structured functions
  extractor: Extractor<TRaw>;
  transformer: Transformer<TRaw>;
  importer?: Importer<TImport>;

  // Optional bulk sync configuration
  bulkSyncConfig?: BulkSyncConfig;

  // Methods
  setup?(): void;
  checkAvailability(baseUrl?: string): Promise<ProviderAvailabilityResult>;
  getListUrl(baseUrl?: string): string;
  buildChatUrl(chatId: string, baseUrl?: string): string;
}

// Provider registry
const providers = new Map<string, Provider>();

export function registerProvider<TRaw, TImport>(provider: Provider<TRaw, TImport>): void {
  providers.set(provider.name, provider as Provider);
}

export function getProvider(name: string): Provider | undefined {
  return providers.get(name);
}

export function getAllProviders(): Provider[] {
  return Array.from(providers.values());
}
