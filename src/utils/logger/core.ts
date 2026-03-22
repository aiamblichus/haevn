/**
 * Core Logger
 *
 * A synchronous, fast logger that delegates to pluggable transports.
 *
 * Key Design Decisions:
 * 1. SYNCHRONOUS - log.info() returns immediately, never blocks
 * 2. NO DEPENDENCIES - doesn't import storage, services, or chrome APIs
 * 3. CONFIGURABLE - minLevel can be updated at runtime without async
 * 4. TRANSPORT-BASED - actual delivery is delegated to transport implementations
 *
 * Usage:
 *   import { log, configureLogger } from './logger/core';
 *
 *   // At startup, configure the transport
 *   configureLogger({ transport: new DirectTransport(buffer) });
 *
 *   // Then log anywhere
 *   log.info("Hello world", { data: 123 });
 */

/// <reference lib="webworker" />

import {
  DEFAULT_LOGGER_CONFIG,
  type LogEntry,
  type LoggerConfig,
  LogLevel,
  type LogTransport,
} from "./types";

// ============================================================================
// State (module-level singletons)
// ============================================================================

/** Current configuration */
let config: LoggerConfig = { ...DEFAULT_LOGGER_CONFIG };

/** Current transport (null = console-only fallback) */
let transport: LogTransport | null = null;

/** Detected context (cached on first log) */
let cachedContext: string | null = null;

// ============================================================================
// Context Detection (runs once, then cached)
// ============================================================================

/**
 * Detect the current execution context.
 * This is intentionally simple and fast.
 */
function detectContext(): string {
  if (cachedContext) return cachedContext;

  // Service Worker detection - check if we're in a ServiceWorkerGlobalScope
  if (typeof self !== "undefined" && "ServiceWorkerGlobalScope" in self) {
    cachedContext = "background";
    return cachedContext;
  }

  // No window = probably background
  if (typeof window === "undefined") {
    cachedContext = "background";
    return cachedContext;
  }

  // Check pathname for extension pages
  const pathname = window.location?.pathname || "";

  if (pathname.includes("/popup.html")) {
    cachedContext = "popup";
  } else if (pathname.includes("/options.html")) {
    cachedContext = "options";
  } else if (pathname.includes("/offscreen.html")) {
    cachedContext = "offscreen";
  } else if (pathname.includes("/viewer.html")) {
    cachedContext = "viewer";
  } else if (pathname.includes("/logs.html")) {
    cachedContext = "logs-viewer";
  } else if (window.location?.protocol === "chrome-extension:") {
    cachedContext = "extension-page";
  } else {
    cachedContext = "content-script";
  }

  return cachedContext;
}

// ============================================================================
// ID Generation (fast, unique enough for logs)
// ============================================================================

let idCounter = 0;

function generateId(): string {
  idCounter = (idCounter + 1) % 1000000;
  return `${Date.now()}_${idCounter.toString(36)}`;
}

// ============================================================================
// Data normalization (preserve Error details across message transport)
// ============================================================================

function normalizeForLog(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): unknown {
  // Keep logs bounded and avoid pathological payloads.
  if (depth > 5) {
    return "[MaxDepthExceeded]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  const valueType = typeof value;
  if (valueType === "string" || valueType === "number" || valueType === "boolean") {
    return value;
  }
  if (valueType === "bigint") {
    return `${value.toString()}n`;
  }
  if (valueType === "symbol") {
    return String(value);
  }
  if (valueType === "function") {
    return `[Function ${(value as (...args: unknown[]) => unknown).name || "anonymous"}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      cause: normalizeForLog((value as Error & { cause?: unknown }).cause, seen, depth + 1),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof RegExp) {
    return value.toString();
  }

  if (valueType === "object") {
    const objectValue = value as Record<string, unknown>;
    if (seen.has(objectValue)) {
      return "[Circular]";
    }
    seen.add(objectValue);

    if (Array.isArray(objectValue)) {
      return objectValue.map((item) => normalizeForLog(item, seen, depth + 1));
    }

    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(objectValue)) {
      normalized[key] = normalizeForLog(nestedValue, seen, depth + 1);
    }
    return normalized;
  }

  return String(value);
}

// ============================================================================
// Core Logging Logic
// ============================================================================

/**
 * Create a log entry and send it via the configured transport.
 * This is synchronous - transport.send() should be fire-and-forget.
 */
function createAndSendLog(
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  levelValue: LogLevel,
  message: string,
  args: unknown[],
): void {
  // Level check (fast path)
  if (levelValue < config.minLevel) {
    return;
  }

  // Extract stack trace from Error arguments
  let stack: string | undefined;
  const error = args.find((arg) => arg instanceof Error) as Error | undefined;
  if (error) {
    stack = error.stack;
  }

  const normalizedArgs = args.length > 0 ? args.map((arg) => normalizeForLog(arg)) : undefined;

  // Build entry
  const entry: LogEntry = {
    id: generateId(),
    timestamp: Date.now(),
    level,
    message,
    context: detectContext(),
    data: normalizedArgs,
    stack,
  };

  // Send via transport (or fallback to console)
  if (transport) {
    try {
      transport.send(entry);
    } catch (err) {
      // Transport failed - fall back to console
      consoleLog(entry);
      console.warn("[Logger] Transport error:", err);
    }
  } else {
    // No transport configured - console only
    consoleLog(entry);
  }
}

/**
 * Fallback: log directly to console
 */
function consoleLog(entry: LogEntry): void {
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

// ============================================================================
// Public API
// ============================================================================

/**
 * Configure the logger.
 * Call once at startup to set the transport and initial config.
 */
export function configureLogger(options: {
  transport?: LogTransport;
  config?: Partial<LoggerConfig>;
}): void {
  if (options.transport) {
    transport = options.transport;
  }
  if (options.config) {
    config = { ...config, ...options.config };
  }
}

/**
 * Update just the log level (e.g., after loading from storage).
 * This is synchronous and safe to call anytime.
 */
export function setLogLevel(level: LogLevel): void {
  config.minLevel = level;
}

/**
 * Get current log level
 */
export function getLogLevel(): LogLevel {
  return config.minLevel;
}

/**
 * The public logger API.
 * All methods are synchronous and never throw.
 */
export const log = {
  debug: (message: string, ...args: unknown[]): void => {
    createAndSendLog("DEBUG", LogLevel.DEBUG, message, args);
  },

  info: (message: string, ...args: unknown[]): void => {
    createAndSendLog("INFO", LogLevel.INFO, message, args);
  },

  warn: (message: string, ...args: unknown[]): void => {
    createAndSendLog("WARN", LogLevel.WARN, message, args);
  },

  error: (message: string, ...args: unknown[]): void => {
    createAndSendLog("ERROR", LogLevel.ERROR, message, args);
  },

  /**
   * Convenience method for updating log level.
   * Note: This is synchronous and immediate.
   */
  setLevel: setLogLevel,
};

export type { LogEntry, LoggerConfig, LogTransport } from "./types";
// Re-export types for convenience
export { LogLevel } from "./types";
