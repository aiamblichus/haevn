/**
 * Logger Types
 *
 * Core types for the transport-based logging system.
 * These are intentionally dependency-free to avoid circular imports.
 */

/**
 * Log severity levels (numeric for comparison)
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * A single log entry with all metadata
 */
export interface LogEntry {
  /** Unique ID for deduplication */
  id: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Severity level */
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  /** Human-readable message */
  message: string;
  /** Execution context (background, popup, content-script, etc.) */
  context: string;
  /** Optional tab ID for content script logs */
  tabId?: number;
  /** Optional URL for context */
  url?: string;
  /** Additional structured data */
  data?: unknown;
  /** Stack trace for errors */
  stack?: string;
}

/**
 * Transport interface - handles delivery of log entries
 *
 * Transports are responsible for getting log entries to their destination:
 * - DirectTransport: Writes to in-memory buffer (background context)
 * - MessageTransport: Sends via chrome.runtime.sendMessage (UI contexts)
 */
export interface LogTransport {
  /**
   * Send a log entry to its destination.
   * Must be synchronous or fire-and-forget async (no awaiting needed).
   */
  send(entry: LogEntry): void;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  /** Minimum level to log (entries below this are dropped) */
  minLevel: LogLevel;
  /** Maximum entries to keep in memory */
  maxEntries: number;
  /** Number of entries to persist to storage */
  persistCount: number;
}

/**
 * Default configuration
 */
export const DEFAULT_LOGGER_CONFIG: LoggerConfig = {
  minLevel: LogLevel.DEBUG,
  maxEntries: 1000,
  persistCount: 500,
};
