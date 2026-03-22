// Provider Interface Definitions
// Enforces consistency across all LLM platform providers

import type { Chat } from "../model/haevn_model";

export interface ExportOptions {
  includeThinking?: boolean;
  includeToolCalls?: boolean;
}

/**
 * Extractor Interface
 * Responsible for extracting raw data from a provider's platform
 * @template TRaw - Provider-specific raw data type
 */
export interface Extractor<TRaw> {
  /**
   * Check if current page is this provider's platform
   */
  isPlatform(): boolean;

  /**
   * Extract chat ID from current URL
   * @param url - URL to extract chat ID from (defaults to current location)
   * @returns Chat ID or null if not found
   */
  extractChatIdFromUrl(url: string): string | null;

  /**
   * Extract current chat data (for single chat sync)
   * @param options - Optional export options
   * @returns Raw platform-specific data
   */
  extractData(options?: ExportOptions): Promise<TRaw>;

  /**
   * Get list of all chat IDs (for bulk sync)
   * @param baseUrl - Optional base URL for the provider
   * @returns Array of chat IDs
   */
  getChatIds?(baseUrl?: string): Promise<string[]>;

  /**
   * Get specific chat data by ID (for bulk sync)
   * @param chatId - ID of the chat to fetch
   * @param baseUrl - Optional base URL for the provider
   * @returns Raw platform-specific data
   */
  getChatData?(chatId: string, baseUrl?: string): Promise<TRaw>;

  /**
   * Optional platform-specific readiness check
   * Called before extractData() to ensure DOM/API is ready
   * @param context - Optional context (e.g., targetChatId for URL verification)
   */
  waitForReady?(context?: { chatId?: string; baseUrl?: string }): Promise<void>;
}

/**
 * Transformer Interface
 * Responsible for transforming provider-specific raw data to HAEVN.Chat format
 * @template TRaw - Provider-specific raw data type
 */
export interface Transformer<TRaw> {
  /**
   * Transform provider-specific raw data to HAEVN.Chat format
   * @param raw - Raw platform-specific data
   * @param tabId - Optional tab ID where the chat was extracted from (for media fetching)
   * @returns Array of HAEVN.Chat objects (some providers can return multiple chats)
   */
  transform(raw: TRaw, tabId?: number): Promise<Chat[]>;

  /**
   * Validate raw data structure (optional)
   * @param raw - Raw platform-specific data
   * @returns Validation result with errors if any
   */
  validate?(raw: TRaw): { valid: boolean; errors: string[] };
}

/**
 * Importer Interface
 * Responsible for importing from external backup files
 * @template TImport - Import file data type
 */
export interface Importer<TImport = unknown> {
  /**
   * Import from external backup file
   * @param data - Parsed import file data
   * @returns Array of HAEVN.Chat objects
   */
  importFromBackup(data: TImport): Promise<Chat[]>;

  /**
   * Detect if file is valid for this importer
   * @param data - Unknown data to validate
   * @returns True if this importer can handle the data
   */
  canImport(data: unknown): boolean;
}
