/**
 * Utilities for processing arrays in chunks to prevent UI blocking.
 * Useful for breaking up long-running operations into smaller, non-blocking chunks.
 */

import type { WindowWithIdleCallback } from "../../types/browser";

/**
 * Split an array into chunks of a specified size.
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

/**
 * Process items in chunks with delays between chunks to yield to the UI thread.
 * This prevents long-running operations from blocking the main thread.
 *
 * @param items - Array of items to process
 * @param processor - Function to process each chunk (receives chunk and returns Promise)
 * @param chunkSize - Number of items per chunk
 * @param delayMs - Delay in milliseconds between chunks (default: 10ms)
 * @returns Promise that resolves when all items are processed
 */
export async function processInChunks<T, R>(
  items: T[],
  processor: (chunk: T[]) => Promise<R>,
  chunkSize: number,
  delayMs: number = 10,
): Promise<R[]> {
  const chunks = chunkArray(items, chunkSize);
  const results: R[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await processor(chunk);
    results.push(result);

    // Yield to UI thread between chunks (except for the last chunk)
    if (i < chunks.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Process items in chunks with a callback for progress tracking.
 * Useful for operations where you want to show progress to the user.
 *
 * @param items - Array of items to process
 * @param processor - Function to process each chunk
 * @param chunkSize - Number of items per chunk
 * @param delayMs - Delay in milliseconds between chunks
 * @param onProgress - Optional callback called after each chunk with (processed, total)
 * @returns Promise that resolves when all items are processed
 */
export async function processInChunksWithProgress<T, R>(
  items: T[],
  processor: (chunk: T[]) => Promise<R>,
  chunkSize: number,
  delayMs: number = 10,
  onProgress?: (processed: number, total: number) => void,
): Promise<R[]> {
  const chunks = chunkArray(items, chunkSize);
  const results: R[] = [];
  let processed = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const result = await processor(chunk);
    results.push(result);
    processed += chunk.length;

    if (onProgress) {
      onProgress(processed, items.length);
    }

    // Yield to UI thread between chunks (except for the last chunk)
    if (i < chunks.length - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Use requestIdleCallback if available, otherwise fall back to setTimeout.
 * This provides better performance when the browser is idle.
 */
export function idleCallback(callback: () => void, timeout?: number): number {
  if (typeof window !== "undefined" && "requestIdleCallback" in window) {
    return (window as WindowWithIdleCallback).requestIdleCallback(() => callback(), { timeout });
  }
  return setTimeout(callback, 0) as unknown as number;
}

/**
 * Process items using requestIdleCallback for better performance.
 * Only processes one item per idle callback to avoid blocking.
 *
 * @param items - Array of items to process
 * @param processor - Function to process each item
 * @param onProgress - Optional callback for progress tracking
 * @returns Promise that resolves when all items are processed
 */
export async function processWithIdleCallback<T>(
  items: T[],
  processor: (item: T, index: number) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  let index = 0;

  const processNext = async (): Promise<void> => {
    if (index >= items.length) {
      return;
    }

    const item = items[index];
    await processor(item, index);
    index++;

    if (onProgress) {
      onProgress(index, items.length);
    }

    if (index < items.length) {
      idleCallback(processNext);
    }
  };

  await processNext();
}
