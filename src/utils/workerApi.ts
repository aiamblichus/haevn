/**
 * Centralized abstraction for MV3 worker messaging.
 * Handles the boilerplate of routing messages through the offscreen document to Web Workers.
 *
 * Three-Tier Architecture: Service Worker → Offscreen Document → Web Worker
 * Service workers cannot create Workers directly, so we route through the offscreen document.
 */

import { ensureOffscreenDocument } from "../background/utils/offscreenUtils";
import type { OffscreenResponse } from "../types/messaging";
import type {
  BulkExportWorkerMessage,
  BulkExportWorkerResponse,
  BulkSyncWorkerMessage,
  BulkSyncWorkerResponse,
  ImportWorkerMessage,
  ImportWorkerResponse,
  SearchWorkerMessage,
  SearchWorkerResponse,
  StatsWorkerMessage,
  StatsWorkerResponse,
  ThumbnailWorkerMessage,
  ThumbnailWorkerResponse,
} from "../types/workerMessages";

/**
 * Supported worker types
 */
export type WorkerType = "search" | "stats" | "thumbnail" | "bulkSync" | "bulkExport" | "import";

/**
 * Map worker types to their message types
 */
export type WorkerMessageMap = {
  search: SearchWorkerMessage;
  stats: StatsWorkerMessage;
  thumbnail: ThumbnailWorkerMessage;
  bulkSync: BulkSyncWorkerMessage;
  bulkExport: BulkExportWorkerMessage;
  import: ImportWorkerMessage;
};

/**
 * Map worker types to their response types
 */
export type WorkerResponseMap = {
  search: SearchWorkerResponse;
  stats: StatsWorkerResponse;
  thumbnail: ThumbnailWorkerResponse;
  bulkSync: BulkSyncWorkerResponse;
  bulkExport: BulkExportWorkerResponse;
  import: ImportWorkerResponse;
};

/**
 * Map worker types to their progress message types (for onProgress callbacks)
 */
export type WorkerProgressMap = {
  search: Extract<SearchWorkerResponse, { type: "searchResultChunk" }>;
  stats: never;
  thumbnail: Extract<ThumbnailWorkerResponse, { type: "batchProgress" }>;
  bulkSync: Extract<BulkSyncWorkerResponse, { type: "progress" } | { type: "postProcess" }>;
  bulkExport: Extract<
    BulkExportWorkerResponse,
    { type: "progress" } | { type: "batchComplete" } | { type: "requestDownload" }
  >;
  import: Extract<
    ImportWorkerResponse,
    { type: "progress" } | { type: "saved" } | { type: "skipped" } | { type: "postProcess" }
  >;
};

/**
 * Options for sending worker requests
 */
export interface WorkerRequestOptions<TProgress = unknown> {
  /** If false, fire-and-forget (no response expected). Default: true */
  expectResponse?: boolean;
  /** Timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /** Callback for progress updates from long-running operations */
  onProgress?: (data: TProgress) => void;
}

/**
 * @deprecated Use WorkerRequestOptions instead
 */
export interface SendWorkerRequestOptions {
  /** Timeout in milliseconds (not currently used, but reserved for future use) */
  timeoutMs?: number;
}

/**
 * Generate a requestId for async operations that require responses or progress tracking.
 * Operations that are truly fire-and-forget (no response, no progress) don't need requestId.
 */
function generateRequestId(
  workerType: WorkerType,
  messageType: string,
  expectResponse: boolean,
  hasProgressCallback: boolean,
): string | undefined {
  // If we're explicitly not expecting a response and have no progress callback, skip requestId
  if (!expectResponse && !hasProgressCallback) {
    return undefined;
  }

  // Operations that need requestId for response correlation
  const needsRequestId =
    // Search
    (workerType === "search" && messageType === "search") ||
    // Stats
    (workerType === "stats" &&
      (messageType === "getProviderStats" || messageType === "getAllProviderStats")) ||
    // Thumbnail
    (workerType === "thumbnail" &&
      (messageType === "checkMissing" ||
        messageType === "getThumbnails" ||
        messageType === "getMediaContent")) ||
    // Import (count operation needs response)
    (workerType === "import" && messageType === "count") ||
    // Any operation with progress callback needs tracking
    hasProgressCallback;

  if (!needsRequestId) {
    return undefined;
  }

  return `${workerType}_${Date.now()}_${Math.random()}`;
}

/**
 * Progress listener management for long-running worker operations
 */
const progressListeners = new Map<
  string,
  { callback: (data: unknown) => void; completionTypes: Set<string> }
>();
let progressListenerSetup = false;

/**
 * Setup global progress listener (runs once)
 */
function setupProgressListener(): void {
  if (progressListenerSetup) return;

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "workerMessage" && message.data?.requestId) {
      const requestId = message.data.requestId as string;
      const listener = progressListeners.get(requestId);

      if (listener) {
        listener.callback(message.data);
        // Note: Listener cleanup is handled inside the callback via the cleanup() function.
        // We intentionally do NOT delete based on completionTypes here because:
        // 1. Search uses streaming with multiple chunks before done=true
        // 2. The callback has the proper logic to cleanup only when truly complete
      }
    }
  });

  progressListenerSetup = true;
}

/**
 * Get completion message types for each worker type
 */
function getCompletionTypes(workerType: WorkerType): Set<string> {
  const completionMap: Record<WorkerType, string[]> = {
    search: ["searchResult", "searchResultChunk", "error"], // chunk with done:true handled separately
    stats: ["providerStatsResult", "allProviderStatsResult", "error"],
    thumbnail: ["batchComplete", "thumbnailsResult", "missingCount", "mediaContentResult", "error"],
    bulkSync: ["cancelled", "paused", "error"],
    bulkExport: ["complete", "cancelled", "paused", "error"],
    import: ["complete", "cancelled", "paused", "count", "error"],
  };

  return new Set(completionMap[workerType]);
}

/**
 * Send a message to a worker via the offscreen document.
 * This abstracts the common boilerplate of MV3 worker messaging.
 *
 * Supports three modes:
 * 1. Fire-and-forget: expectResponse=false, no onProgress
 * 2. Request/Response: expectResponse=true (default), no onProgress
 * 3. Progress callbacks: onProgress provided (for long-running operations)
 *
 * @param workerType - The type of worker to send the message to
 * @param message - The message to send (must match the worker's message type)
 * @param options - Optional configuration (expectResponse, timeout, onProgress)
 * @returns Promise that resolves to the worker's response (or void for fire-and-forget)
 */
export async function sendWorkerRequest<T extends WorkerType>(
  workerType: T,
  message: WorkerMessageMap[T],
  options?: WorkerRequestOptions<WorkerProgressMap[T]>,
): Promise<WorkerResponseMap[T] | undefined> {
  const { expectResponse = true, timeout = 30000, onProgress } = options || {};

  // Ensure offscreen document exists (it's persistent, so this is usually a no-op)
  await ensureOffscreenDocument();

  // Generate requestId for async operations that need responses or progress tracking
  const requestId = generateRequestId(
    workerType,
    (message as { type: string }).type,
    expectResponse,
    !!onProgress,
  );

  // Add requestId to the message object if needed (offscreen document expects it in the message)
  const messageWithRequestId = requestId
    ? ({ ...message, requestId } as WorkerMessageMap[T])
    : message;

  // Fire-and-forget mode: send and resolve immediately
  if (!expectResponse && !onProgress) {
    chrome.runtime.sendMessage({
      type: "workerRequest",
      workerType,
      operation: (message as { type: string }).type,
      data: messageWithRequestId,
      requestId,
    });
    return Promise.resolve();
  }

  // Progress callback mode: register listener and handle completion
  if (onProgress && requestId) {
    setupProgressListener();

    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let completed = false;

      const cleanup = () => {
        completed = true;
        if (timeoutId) clearTimeout(timeoutId);
        progressListeners.delete(requestId);
      };

      const completionTypes = getCompletionTypes(workerType);

      // Register progress listener
      progressListeners.set(requestId, {
        callback: (data: unknown) => {
          if (completed) return;

          const typedData = data as WorkerProgressMap[T];
          const rawData = data as { type: string; error?: string };

          // Call progress callback FIRST (so we don't lose the final chunk's data)
          onProgress(typedData);

          // Handle search streaming special case (done flag)
          // Must check AFTER calling onProgress so the final results are processed
          if (
            workerType === "search" &&
            "done" in typedData &&
            (typedData as { done: boolean }).done
          ) {
            cleanup();
            resolve(typedData as WorkerResponseMap[T]);
            return;
          }

          // Check for completion messages (but NOT for search - that's handled by done flag above)
          if (
            workerType !== "search" &&
            "type" in typedData &&
            completionTypes.has(typedData.type as string)
          ) {
            cleanup();
            resolve(typedData as WorkerResponseMap[T]);
          } else if ("type" in rawData && rawData.type === "error") {
            cleanup();
            reject(
              new Error(
                "error" in rawData && typeof rawData.error === "string"
                  ? rawData.error
                  : "Worker error",
              ),
            );
          }
        },
        completionTypes,
      });

      // Set timeout
      timeoutId = setTimeout(() => {
        if (!completed) {
          cleanup();
          reject(new Error(`Worker request timeout: ${workerType} (${timeout}ms)`));
        }
      }, timeout);

      // Send message
      chrome.runtime.sendMessage({
        type: "workerRequest",
        workerType,
        operation: (message as { type: string }).type,
        data: messageWithRequestId,
        requestId,
      });
    });
  }

  // Request/Response mode (original behavior)
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      {
        type: "workerRequest",
        workerType,
        operation: (message as { type: string }).type,
        data: messageWithRequestId,
        requestId,
      },
      (response: OffscreenResponse | undefined) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!response) {
          reject(new Error("No response from offscreen document"));
          return;
        }

        if (!response.success) {
          reject(new Error(response.error || "Worker request failed"));
          return;
        }

        // Extract result from worker response
        // The offscreen document wraps the worker's response in result
        if (response.result) {
          resolve(response.result as WorkerResponseMap[T]);
        } else {
          // Fire-and-forget operations return undefined, but we need to resolve with a valid response
          // For now, we'll resolve with a minimal response object
          // This should only happen for operations that don't need responses
          resolve(undefined as unknown as WorkerResponseMap[T]);
        }
      },
    );
  });
}
