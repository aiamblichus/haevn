/**
 * Background Bootstrap
 *
 * This file MUST be imported first in background.ts.
 * It initializes critical infrastructure before any other code runs:
 *
 * 1. Storage Adapter - Required by any code that uses chrome.storage abstraction
 * 2. Logger Transport - Configures DirectTransport so logs work immediately
 *
 * Order matters! Storage must be ready before LoggerService can load config.
 */

import { loggerService } from "../services/loggerService";
import { ChromeStorageAdapter, setStorageAdapter } from "../storage";
import { configureLogger, DirectTransport, type LogEntry } from "../utils/logger";

// 1. Initialize storage adapter FIRST
setStorageAdapter(new ChromeStorageAdapter());

// 2. Configure logger with DirectTransport
//    This creates the transport that sends logs to LoggerService
const transport = new DirectTransport((entry: LogEntry) => {
  loggerService.addEntry(entry);
});

configureLogger({ transport });

// 3. Initialize LoggerService (async, but we fire-and-forget)
//    This loads persisted logs and config from storage
loggerService.init().catch((err) => {
  console.error("[Bootstrap] LoggerService init failed:", err);
});

import { diagnosticsService } from "../services/diagnosticsService";

diagnosticsService.init().catch((err) => {
  console.error("[Bootstrap] DiagnosticsService init failed:", err);
});
