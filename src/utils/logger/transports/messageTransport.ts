/**
 * Message Transport
 *
 * Used in non-background contexts (popup, options, content scripts, viewer).
 * Sends log entries to the background service worker via chrome.runtime.sendMessage.
 *
 * Design:
 * - Fire-and-forget: sendMessage is called but not awaited
 * - Fallback: If messaging fails, logs to console
 * - No blocking: Never delays the caller
 * - Size-safe: Truncates oversized log data to prevent 64MB limit crashes
 */

import { ensureSafeMessage } from "../../messageSafety";
import type { LogEntry, LogTransport } from "../types";

/**
 * MessageTransport sends logs to background via chrome.runtime.sendMessage.
 */
export class MessageTransport implements LogTransport {
  private echoToConsole: boolean;

  constructor(options?: { echoToConsole?: boolean }) {
    // In UI contexts, we typically want console echo for local debugging
    this.echoToConsole = options?.echoToConsole ?? true;
  }

  send(entry: LogEntry): void {
    // Echo to local console
    if (this.echoToConsole) {
      this.echoLog(entry);
    }

    // Send to background (fire-and-forget)
    this.sendToBackground(entry);
  }

  private sendToBackground(entry: LogEntry): void {
    // Check if chrome.runtime is available
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
      // Not in extension context - console-only is fine
      return;
    }

    try {
      const message = {
        type: "LOG",
        data: {
          level: entry.level,
          message: entry.message,
          data: entry.data,
          stack: entry.stack,
        },
      };

      // Check message size before sending
      const safeResult = ensureSafeMessage(message);
      if (!safeResult.safe) {
        console.warn("[MessageTransport] Log entry too large, truncating:", safeResult.warning);
      }

      // Fire and forget - don't await
      chrome.runtime.sendMessage(safeResult.message).catch(() => {
        // Silently ignore - we already echoed to console
        // Common case: extension context invalidated during reload
      });
    } catch {
      // Synchronous error (rare) - already logged to console
    }
  }

  private echoLog(entry: LogEntry): void {
    const prefix = `[${entry.context}]`;
    const args = entry.data ? [prefix, entry.message, entry.data] : [prefix, entry.message];

    switch (entry.level) {
      case "DEBUG":
        console.debug(...args);
        break;
      case "INFO":
        console.info(...args);
        break;
      case "WARN":
        console.warn(...args);
        break;
      case "ERROR":
        console.error(...args, entry.stack || "");
        break;
    }
  }
}
