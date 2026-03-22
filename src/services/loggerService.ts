/**
 * @file Centralized logging service for HAEVN extension
 * @description Aggregates logs from all extension contexts into a single hub.
 *
 * Architecture (Transport Pattern):
 * - This service is the "receiver" for DirectTransport in the background context
 * - It receives LogEntry objects and manages:
 *   - In-memory circular buffer
 *   - Persistence to chrome.storage (debounced)
 *   - Query/filter APIs
 *
 * The service does NOT import `log` from the logger module to avoid circular deps.
 * All internal logging uses console.* directly.
 */

import type { LogEntry } from "../utils/logger/types";
import { DEFAULT_LOGGER_CONFIG, type LoggerConfig, LogLevel } from "../utils/logger/types";

// Storage keys
const STORAGE_KEY_CONFIG = "logger:config";
const STORAGE_KEY_ENTRIES = "logger:entries";

// Debounce timer for persistence
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 1000;

/**
 * Filter options for getLogs()
 */
export interface LogFilter {
  context?: string;
  level?: "DEBUG" | "INFO" | "WARN" | "ERROR";
  since?: number;
  match?: string;
}

class LoggerService {
  private logs: LogEntry[] = [];
  private config: LoggerConfig = { ...DEFAULT_LOGGER_CONFIG };
  private initialized = false;
  private storage: typeof chrome.storage.local | null = null;

  /**
   * Initialize the logger service.
   * Loads persisted config and logs from storage.
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // Check if chrome.storage is available
    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      this.storage = chrome.storage.local;
    }

    try {
      // Load config from storage
      if (this.storage) {
        const result = await this.storage.get(STORAGE_KEY_CONFIG);
        if (result[STORAGE_KEY_CONFIG]) {
          this.config = { ...DEFAULT_LOGGER_CONFIG, ...result[STORAGE_KEY_CONFIG] };
        }

        // Load persisted logs
        const logsResult = await this.storage.get(STORAGE_KEY_ENTRIES);
        if (logsResult[STORAGE_KEY_ENTRIES] && Array.isArray(logsResult[STORAGE_KEY_ENTRIES])) {
          this.logs = logsResult[STORAGE_KEY_ENTRIES];
          // Trim to max
          if (this.logs.length > this.config.maxEntries) {
            this.logs = this.logs.slice(-this.config.maxEntries);
          }
        }
      }

      this.initialized = true;
      console.info("[LoggerService] Initialized", {
        config: this.config,
        loadedLogs: this.logs.length,
      });
    } catch (err) {
      console.error("[LoggerService] Init failed:", err);
      // Continue with defaults
      this.initialized = true;
    }
  }

  private listeners: Set<(entry: LogEntry) => void> = new Set();

  /**
   * Add a log entry to the buffer.
   * This is called by DirectTransport.
   */
  addEntry(entry: LogEntry): void {
    this.logs.push(entry);

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        console.error("[LoggerService] Listener failed", err);
      }
    }

    // Trim if over max (circular buffer)
    if (this.logs.length > this.config.maxEntries) {
      this.logs = this.logs.slice(-this.config.maxEntries);
    }

    // Schedule persistence
    this.schedulePersistence();
  }

  /**
   * Register a listener for new log entries.
   */
  addListener(listener: (entry: LogEntry) => void): void {
    this.listeners.add(listener);
  }

  /**
   * Unregister a log listener.
   */
  removeListener(listener: (entry: LogEntry) => void): void {
    this.listeners.delete(listener);
  }

  /**
   * Legacy method for receiving LOG messages from non-background contexts.
   * Converts the message format to LogEntry and adds it.
   */
  addLog(
    logData: {
      level: "DEBUG" | "INFO" | "WARN" | "ERROR";
      message: string;
      data?: unknown;
      stack?: string;
    },
    sender: chrome.runtime.MessageSender,
  ): void {
    const context = this.identifyContext(sender);

    const entry: LogEntry = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      level: logData.level,
      message: logData.message,
      context,
      tabId: sender.tab?.id,
      url: sender.url,
      data: logData.data,
      stack: logData.stack,
    };

    // Echo to console for immediate visibility
    this.echoToConsole(entry);

    // Add to buffer
    this.addEntry(entry);
  }

  /**
   * Get logs with optional filtering.
   */
  getLogs(filter?: LogFilter): LogEntry[] {
    let filtered = [...this.logs];

    if (filter?.context) {
      filtered = filtered.filter((log) => log.context === filter.context);
    }

    if (filter?.level) {
      filtered = filtered.filter((log) => log.level === filter.level);
    }

    if (filter?.since !== undefined) {
      const since = filter.since;
      filtered = filtered.filter((log) => log.timestamp >= since);
    }

    if (filter?.match) {
      const searchTerm = filter.match.toLowerCase();
      filtered = filtered.filter((log) => {
        // Search in message
        if (log.message.toLowerCase().includes(searchTerm)) {
          return true;
        }
        // Search in context
        if (log.context.toLowerCase().includes(searchTerm)) {
          return true;
        }
        // Search in data if present
        if (log.data !== undefined && log.data !== null) {
          try {
            const dataStr = typeof log.data === "string" ? log.data : JSON.stringify(log.data);
            if (dataStr.toLowerCase().includes(searchTerm)) {
              return true;
            }
          } catch {
            // Ignore stringify errors
          }
        }
        return false;
      });
    }

    return filtered;
  }

  /**
   * Clear all logs.
   */
  async clearLogs(): Promise<void> {
    this.logs = [];
    if (this.storage) {
      try {
        await this.storage.remove(STORAGE_KEY_ENTRIES);
      } catch (err) {
        console.error("[LoggerService] Failed to clear persisted logs:", err);
      }
    }
  }

  /**
   * Get current config.
   */
  getConfig(): LoggerConfig {
    return { ...this.config };
  }

  /**
   * Update config and persist.
   */
  async setConfig(newConfig: Partial<LoggerConfig>): Promise<void> {
    this.config = { ...this.config, ...newConfig };
    if (this.storage) {
      try {
        await this.storage.set({ [STORAGE_KEY_CONFIG]: this.config });
      } catch (err) {
        console.error("[LoggerService] Failed to save config:", err);
        throw err;
      }
    }
  }

  /**
   * Identify context from message sender.
   */
  private identifyContext(sender: chrome.runtime.MessageSender): string {
    // Background service worker
    if (!sender.tab && !sender.frameId && !sender.url) {
      return "background";
    }

    // Content script
    if (sender.tab) {
      return `content-tab-${sender.tab.id}`;
    }

    // Check URL for popup/options/viewer
    if (sender.url) {
      if (sender.url.includes("/popup.html")) return "popup";
      if (sender.url.includes("/options.html")) return "options";
      if (sender.url.includes("/offscreen.html")) return "offscreen";
      if (sender.url.includes("/viewer.html")) return "viewer";

      try {
        const url = new URL(sender.url);
        return url.pathname.split("/").pop() || "unknown";
      } catch {
        return "unknown";
      }
    }

    return "unknown";
  }

  /**
   * Echo log to console for immediate visibility.
   */
  private echoToConsole(entry: LogEntry): void {
    const prefix = `[${entry.context}]`;
    const timestamp = new Date(entry.timestamp).toISOString();

    switch (entry.level) {
      case "DEBUG":
        console.debug(prefix, timestamp, entry.message, entry.data);
        break;
      case "INFO":
        console.info(prefix, timestamp, entry.message, entry.data);
        break;
      case "WARN":
        console.warn(prefix, timestamp, entry.message, entry.data);
        break;
      case "ERROR":
        console.error(prefix, timestamp, entry.message, entry.data, entry.stack);
        break;
    }
  }

  /**
   * Schedule persistence (debounced).
   */
  private schedulePersistence(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
    }

    persistTimer = setTimeout(() => {
      this.persistLogs();
    }, PERSIST_DEBOUNCE_MS);
  }

  /**
   * Persist logs to storage.
   */
  private async persistLogs(): Promise<void> {
    if (!this.storage) return;

    try {
      const toPersist = this.logs.slice(-this.config.persistCount);
      await this.storage.set({ [STORAGE_KEY_ENTRIES]: toPersist });
    } catch (err) {
      console.error("[LoggerService] Failed to persist logs:", err);
    }
  }
}

// Singleton instance
export const loggerService = new LoggerService();

// Re-export types
export { LogLevel };
export type { LogEntry, LoggerConfig };
