/**
 * @file Error handling utilities
 * @description Utilities for consistent error handling across the extension
 */

import { log } from "./logger";

/**
 * Safely executes a promise that can fail without disrupting control flow.
 * Logs failures for debugging but doesn't throw.
 *
 * Use this for fire-and-forget operations where:
 * - Failures are expected or acceptable
 * - The operation should not block execution
 * - Debugging visibility is needed
 *
 * @param promise - The promise to execute
 * @param context - Descriptive context for logging (e.g., "Cleanup staged import file")
 *
 * @example
 * ```typescript
 * fireAndForget(
 *   requestDeleteStagedFile(filePath),
 *   "Cleanup staged import file after completion"
 * );
 * ```
 */
export function fireAndForget(promise: Promise<unknown>, context: string): void {
  promise.catch((err) => {
    log.warn(`[FireAndForget] ${context}:`, err);
  });
}
