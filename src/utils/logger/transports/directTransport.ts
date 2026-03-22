/**
 * Direct Transport
 *
 * Used in the background/service worker context.
 * Writes log entries directly to an in-memory buffer and echoes to console.
 *
 * The buffer is managed by LoggerService, which handles:
 * - Circular buffer trimming
 * - Persistence to storage (debounced)
 * - Query/filter APIs
 */

import type { LogEntry, LogTransport } from "../types";

/**
 * Callback type for receiving log entries
 */
export type LogReceiver = (entry: LogEntry) => void;

/**
 * DirectTransport sends logs to a receiver function (typically LoggerService.addEntry).
 * This breaks the circular dependency: logger -> transport -> receiver (injected).
 */
export class DirectTransport implements LogTransport {
  private receiver: LogReceiver;
  private echoToConsole: boolean;

  constructor(receiver: LogReceiver, options?: { echoToConsole?: boolean }) {
    this.receiver = receiver;
    this.echoToConsole = options?.echoToConsole ?? true;
  }

  send(entry: LogEntry): void {
    // Echo to console for immediate dev tools visibility
    if (this.echoToConsole) {
      this.echoLog(entry);
    }

    // Forward to receiver (LoggerService)
    try {
      this.receiver(entry);
    } catch (err) {
      // Receiver failed - already echoed to console, so just warn
      console.warn("[DirectTransport] Receiver error:", err);
    }
  }

  private echoLog(entry: LogEntry): void {
    const prefix = `[${entry.context}]`;
    const timestamp = new Date(entry.timestamp).toISOString();
    const args = entry.data
      ? [prefix, timestamp, entry.message, entry.data]
      : [prefix, timestamp, entry.message];

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
