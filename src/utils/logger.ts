/**
 * Logger - Backwards Compatibility Shim
 *
 * This file re-exports from the new logger module for backwards compatibility.
 * All existing `import { log } from '../utils/logger'` statements continue to work.
 *
 * The new logger architecture is in src/utils/logger/:
 * - core.ts: Synchronous logger with pluggable transports
 * - types.ts: LogEntry, LogTransport, LoggerConfig
 * - transports/: DirectTransport (background), MessageTransport (UI)
 *
 * Configuration is done in:
 * - background/bootstrap.ts: DirectTransport for service worker
 * - Non-background contexts: Auto-configure with MessageTransport
 */

/// <reference lib="webworker" />

import { configureLogger, log as coreLog, LogLevel, MessageTransport } from "./logger/index";

// Auto-configure MessageTransport for non-background contexts
// This runs when the module is first imported
function autoConfigureTransport(): void {
  // Check if we're in service worker context - if so, bootstrap.ts handles config
  if (typeof self !== "undefined" && "ServiceWorkerGlobalScope" in self) {
    return; // Background context - already configured by bootstrap.ts
  }

  // Non-background context: use MessageTransport
  configureLogger({
    transport: new MessageTransport({ echoToConsole: true }),
  });
}

// Run auto-configuration
autoConfigureTransport();

// Re-export for backwards compatibility
export const log = coreLog;
export { LogLevel, configureLogger };

// Legacy type re-exports
export type { LogEntry, LoggerConfig } from "./logger/index";

// Transport re-exports for bootstrap
export { DirectTransport, MessageTransport } from "./logger/index";
