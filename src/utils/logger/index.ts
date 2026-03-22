/**
 * Logger Module
 *
 * This is the main entry point for the logging system.
 *
 * Architecture:
 * - core.ts: Synchronous logger with pluggable transports
 * - types.ts: LogEntry, LogTransport, LoggerConfig types
 * - transports/: DirectTransport (background), MessageTransport (UI)
 *
 * Usage:
 *   import { log } from '../utils/logger';
 *   log.info("Hello world");
 *
 * Configuration (done once at startup):
 *   import { configureLogger } from '../utils/logger';
 *   import { DirectTransport } from '../utils/logger/transports';
 *
 *   configureLogger({ transport: new DirectTransport(receiver) });
 */

// Core exports
export { configureLogger, getLogLevel, log, setLogLevel } from "./core";
// Transport exports (for configuration)
export { DirectTransport, MessageTransport } from "./transports";
export type { LogEntry, LoggerConfig, LogTransport } from "./types";
// Type exports
export { LogLevel } from "./types";
