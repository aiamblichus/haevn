// Offscreen Document - Manages iframe for DOM extraction and Web Workers
// This document creates an iframe pointing to external URLs and manages Web Workers.
// The service worker handles content script injection and message passing.
//
// Three-Tier Architecture:
//   UI → Service Worker → Offscreen Document → Web Workers
//
// Offscreen documents can create Workers (service workers cannot), so this acts as
// the Worker Host tier, routing messages between service worker and workers.

import type {
  OffscreenEvent,
  OffscreenIframeInfo,
  OffscreenRequest,
  OffscreenResponse,
} from "../types/messaging";
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
import { log } from "../utils/logger";
import { ensureSafeMessage } from "../utils/messageSafety";
import { deleteFileFromOpfs, getFile, readFileFromOpfs } from "../utils/opfs";

type OffscreenWorkerRequest = Extract<OffscreenRequest, { type: "workerRequest" }>;

log.info("[Offscreen] Offscreen document loaded");

let currentIframe: HTMLIFrameElement | null = null;
let iframeReady = false;

// Worker management
let searchWorker: Worker | null = null;
let statsWorker: Worker | null = null;
let bulkExportWorker: Worker | null = null;
let bulkSyncWorker: Worker | null = null;
let thumbnailWorker: Worker | null = null;
let importWorker: Worker | null = null;

// Pending worker requests (for request/response pattern)
const pendingWorkerRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: unknown) => void }
>();

/**
 * Create a new iframe pointing to the target URL
 */
function createIframe(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Remove existing iframe if present
    if (currentIframe) {
      currentIframe.remove();
      currentIframe = null;
      iframeReady = false;
    }

    // Create new iframe
    const iframe = document.createElement("iframe");
    iframe.src = url;
    iframe.id = `haevn-extractor-iframe-${Date.now()}`;
    iframe.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
    `;

    // Wait for iframe to load
    iframe.onload = () => {
      log.info(`[Offscreen] Iframe loaded: ${url}`);
      currentIframe = iframe;
      iframeReady = true;

      // Notify service worker that iframe is ready
      const event: OffscreenEvent = {
        type: "offscreenIframeReady",
        iframeId: iframe.id,
        url: url,
      };
      chrome.runtime.sendMessage(event).catch((err) => {
        log.warn("[Offscreen] Failed to notify service worker:", err);
      });

      resolve();
    };

    iframe.onerror = (error) => {
      log.error(`[Offscreen] Iframe load error for ${url}:`, error);
      iframeReady = false;
      reject(new Error(`Failed to load iframe: ${url}`));
    };

    document.body.appendChild(iframe);
  });
}

/**
 * Capture a frame from a video to use as a thumbnail
 */
async function captureVideoFrame(
  videoData: ArrayBuffer | string,
  mimeType: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    let url: string;

    if (videoData instanceof ArrayBuffer) {
      const blob = new Blob([videoData], { type: mimeType });
      url = URL.createObjectURL(blob);
    } else {
      url = videoData;
    }

    video.src = url;
    video.muted = true;
    video.playsInline = true;

    // Use a timeout to avoid hanging forever
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Video thumbnail generation timed out"));
    }, 15000);

    const cleanup = () => {
      clearTimeout(timeout);
      if (videoData instanceof ArrayBuffer) {
        URL.revokeObjectURL(url);
      }
      video.remove();
    };

    video.onloadeddata = () => {
      // Seek to 0.5s or 1% of duration, whichever is smaller, to avoid black frames at the start
      video.currentTime = Math.min(0.5, video.duration * 0.01);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.75);
          resolve(dataUrl);
        } else {
          reject(new Error("Failed to get canvas context"));
        }
      } catch (err) {
        reject(err);
      } finally {
        cleanup();
      }
    };

    video.onerror = () => {
      cleanup();
      reject(new Error("Failed to load video"));
    };
  });
}

/**
 * Navigate existing iframe to a new URL
 */
function navigateIframe(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!currentIframe) {
      reject(new Error("No iframe exists"));
      return;
    }

    iframeReady = false;
    if (!currentIframe) {
      reject(new Error("No iframe available for navigation"));
      return;
    }
    currentIframe.onload = () => {
      log.info(`[Offscreen] Iframe navigated to: ${url}`);
      iframeReady = true;

      // Notify service worker that iframe navigated
      const event: OffscreenEvent = {
        type: "offscreenIframeNavigated",
        iframeId: currentIframe?.id,
        url: url,
      };
      chrome.runtime.sendMessage(event).catch((err) => {
        log.warn("[Offscreen] Failed to notify service worker:", err);
      });

      resolve();
    };

    currentIframe.onerror = (error) => {
      log.error(`[Offscreen] Iframe navigation error for ${url}:`, error);
      iframeReady = false;
      reject(new Error(`Failed to navigate iframe: ${url}`));
    };

    currentIframe.src = url;
  });
}

/**
 * Get current iframe information
 */
function getIframeInfo(): OffscreenIframeInfo {
  return {
    iframeId: currentIframe?.id || null,
    url: currentIframe?.src || null,
    ready: iframeReady,
  };
}

// ============================================================================
// Worker Management
// ============================================================================

/**
 * Initialize search worker (lazy initialization)
 */
function initSearchWorker(): Worker {
  if (searchWorker) {
    log.debug("[Offscreen] Search worker already initialized, reusing");
    return searchWorker;
  }

  log.info("[Offscreen] Initializing search worker...");
  const workerUrl = chrome.runtime.getURL("search.worker.js");
  log.debug("[Offscreen] Search worker URL:", workerUrl);

  try {
    searchWorker = new Worker(workerUrl);
    log.info("[Offscreen] Search worker created successfully");

    searchWorker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
      log.debug("[Offscreen] Search worker message received:", {
        type: event.data.type,
        hasRequestId: "requestId" in event.data,
      });
      handleWorkerMessage("search", event.data);
    };

    searchWorker.onerror = (error) => {
      log.error("[Offscreen] Search worker CRASHED:", {
        message: error.message,
        filename: error.filename,
        lineno: error.lineno,
        colno: error.colno,
        error: error.error,
        type: error.type,
      });
      searchWorker = null;
    };

    log.info("[Offscreen] Search worker initialized and ready");
    return searchWorker;
  } catch (error) {
    log.error("[Offscreen] Failed to create search worker:", error);
    throw error;
  }
}

/**
 * Initialize stats worker (lazy initialization)
 */
function initStatsWorker(): Worker {
  if (statsWorker) return statsWorker;

  const workerUrl = chrome.runtime.getURL("stats.worker.js");
  statsWorker = new Worker(workerUrl);

  statsWorker.onmessage = (event: MessageEvent<StatsWorkerResponse>) => {
    handleWorkerMessage("stats", event.data);
  };

  statsWorker.onerror = (error) => {
    log.error("[Offscreen] Stats worker error:", error);
    statsWorker = null;
  };

  log.info("[Offscreen] Stats worker initialized");
  return statsWorker;
}

/**
 * Initialize bulk export worker (lazy initialization)
 */
function initBulkExportWorker(): Worker {
  if (bulkExportWorker) return bulkExportWorker;

  const workerUrl = chrome.runtime.getURL("bulkExport.worker.js");
  bulkExportWorker = new Worker(workerUrl);

  bulkExportWorker.onmessage = (event: MessageEvent<BulkExportWorkerResponse>) => {
    handleWorkerMessage("bulkExport", event.data);
  };

  bulkExportWorker.onerror = (error) => {
    log.error("[Offscreen] Bulk export worker error:", error);
    bulkExportWorker = null;
  };

  log.info("[Offscreen] Bulk export worker initialized");
  return bulkExportWorker;
}

/**
 * Initialize bulk sync worker (lazy initialization)
 */
function initBulkSyncWorker(): Worker {
  if (bulkSyncWorker) return bulkSyncWorker;

  const workerUrl = chrome.runtime.getURL("bulkSync.worker.js");
  bulkSyncWorker = new Worker(workerUrl);

  bulkSyncWorker.onmessage = (event: MessageEvent<BulkSyncWorkerResponse>) => {
    handleWorkerMessage("bulkSync", event.data);
  };

  bulkSyncWorker.onerror = (error) => {
    log.error("[Offscreen] Bulk sync worker error:", error);
    bulkSyncWorker = null;
  };

  log.info("[Offscreen] Bulk sync worker initialized");
  return bulkSyncWorker;
}

/**
 * Initialize thumbnail worker (lazy initialization)
 */
function initThumbnailWorker(): Worker {
  if (thumbnailWorker) return thumbnailWorker;

  const workerUrl = chrome.runtime.getURL("thumbnail.worker.js");
  thumbnailWorker = new Worker(workerUrl);

  thumbnailWorker.onmessage = (event: MessageEvent<ThumbnailWorkerResponse>) => {
    handleWorkerMessage("thumbnail", event.data);
  };

  thumbnailWorker.onerror = (error) => {
    log.error("[Offscreen] Thumbnail worker error:", error);
    thumbnailWorker = null;
  };

  log.info("[Offscreen] Thumbnail worker initialized");
  return thumbnailWorker;
}

/**
 * Initialize import worker (lazy initialization)
 */
function initImportWorker(): Worker {
  if (importWorker) {
    log.info("[Offscreen] Import worker already initialized, reusing");
    return importWorker;
  }

  const workerUrl = chrome.runtime.getURL("import.worker.js");
  log.info("[Offscreen] Initializing import worker from:", workerUrl);

  importWorker = new Worker(workerUrl);

  importWorker.onmessage = (event: MessageEvent<ImportWorkerResponse>) => {
    log.info("[Offscreen] Import worker message received:", event.data.type);
    handleWorkerMessage("import", event.data);
  };

  importWorker.onerror = (error) => {
    log.error("[Offscreen] Import worker error:", error);
    importWorker = null;
  };

  log.info("[Offscreen] Import worker initialized successfully");
  return importWorker;
}

/**
 * Handle messages from workers and route back to service worker
 */
function handleWorkerMessage(
  workerType: "search" | "stats" | "bulkExport" | "bulkSync" | "thumbnail" | "import",
  data:
    | SearchWorkerResponse
    | StatsWorkerResponse
    | BulkExportWorkerResponse
    | BulkSyncWorkerResponse
    | ThumbnailWorkerResponse
    | ImportWorkerResponse,
): void {
  // If this is a response with a requestId, resolve the pending request
  const requestId =
    "requestId" in data && typeof data.requestId === "string" ? data.requestId : undefined;

  log.debug(`[Offscreen] handleWorkerMessage called:`, {
    workerType,
    messageType: data.type,
    requestId,
    hasPendingRequest: requestId ? pendingWorkerRequests.has(requestId) : false,
  });

  if (requestId && pendingWorkerRequests.has(requestId)) {
    log.debug(`[Offscreen] Resolving pending request:`, {
      workerType,
      requestId,
      messageType: data.type,
    });
    const pending = pendingWorkerRequests.get(requestId);
    if (!pending) {
      log.warn(`[Offscreen] No pending request found for requestId: ${requestId}`);
      return;
    }
    pendingWorkerRequests.delete(requestId);

    if (data.type === "error" || ("error" in data && data.error)) {
      const errorMessage =
        data.type === "error"
          ? data.error
          : "error" in data && typeof data.error === "string"
            ? data.error
            : "Worker error";
      log.error(`[Offscreen] Worker returned error, rejecting promise:`, {
        workerType,
        requestId,
        error: errorMessage,
      });
      pending.reject(new Error(errorMessage));
    } else {
      log.debug(`[Offscreen] Worker returned success, resolving promise:`, {
        workerType,
        requestId,
        messageType: data.type,
      });
      pending.resolve(data);
    }
    return;
  }

  // Forward other messages to service worker (e.g., progress updates)
  log.debug(`[Offscreen] Forwarding worker message to service worker:`, {
    workerType,
    messageType: data.type,
    requestId,
    hasResults: "results" in data ? !!data.results : false,
    resultsLength:
      "results" in data && Array.isArray(data.results) ? data.results.length : undefined,
    done: "done" in data ? data.done : undefined,
  });

  // Intercept special requests from workers that can be handled here in the offscreen document
  if (workerType === "thumbnail" && data.type === "requestVideoThumbnail") {
    const { requestId, videoData, mimeType } = data;
    log.info(`[Offscreen] Intercepted video thumbnail request: ${requestId}`);

    captureVideoFrame(videoData, mimeType)
      .then((thumbnailUrl) => {
        thumbnailWorker?.postMessage({
          type: "videoThumbnailResponse",
          requestId,
          thumbnailUrl,
        });
      })
      .catch((err) => {
        log.error(`[Offscreen] Video thumbnail generation failed:`, err);
        thumbnailWorker?.postMessage({
          type: "videoThumbnailResponse",
          requestId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return;
  }

  const event: OffscreenEvent = {
    type: "workerMessage",
    workerType,
    data,
  };

  // Check message size before sending (Chrome has 64MB limit)
  const safeResult = ensureSafeMessage(event);
  if (!safeResult.safe) {
    log.error(`[Offscreen] BLOCKED oversized worker message:`, {
      workerType,
      messageType: data.type,
      warning: safeResult.warning,
    });
    // Don't send - it would crash the extension
    return;
  }

  chrome.runtime.sendMessage(event).catch((err) => {
    log.error(`[Offscreen] Failed to forward ${workerType} worker message:`, {
      workerType,
      messageType: data.type,
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Route a message to a specific worker
 */
function postMessageWithTransfer(
  worker: Worker,
  message:
    | SearchWorkerMessage
    | StatsWorkerMessage
    | BulkExportWorkerMessage
    | BulkSyncWorkerMessage
    | ThumbnailWorkerMessage
    | ImportWorkerMessage,
  transferList?: Transferable[],
): void {
  if (transferList && transferList.length > 0) {
    worker.postMessage(message, transferList);
  } else {
    worker.postMessage(message);
  }
}

async function routeToWorker(
  workerType: "search" | "stats" | "bulkExport" | "bulkSync" | "thumbnail" | "import",
  message:
    | SearchWorkerMessage
    | StatsWorkerMessage
    | BulkExportWorkerMessage
    | BulkSyncWorkerMessage
    | ThumbnailWorkerMessage
    | ImportWorkerMessage,
  transferList?: Transferable[],
): Promise<unknown> {
  let worker: Worker | null = null;

  log.debug(`[Offscreen] routeToWorker called:`, {
    workerType,
    messageType: message.type,
    hasRequestId: "requestId" in message,
    requestId: "requestId" in message ? message.requestId : undefined,
    hasTransferList: !!transferList,
  });

  // Initialize worker if needed
  log.info(`[Offscreen] Initializing worker if needed:`, { workerType });
  switch (workerType) {
    case "search":
      log.info(`[Offscreen] Calling initSearchWorker`);
      worker = initSearchWorker();
      log.info(`[Offscreen] Search worker initialized:`, {
        hasWorker: !!worker,
      });
      break;
    case "stats":
      worker = initStatsWorker();
      break;
    case "bulkExport":
      worker = initBulkExportWorker();
      break;
    case "bulkSync":
      worker = initBulkSyncWorker();
      break;
    case "thumbnail":
      worker = initThumbnailWorker();
      break;
    case "import":
      worker = initImportWorker();
      break;
  }

  if (!worker) {
    log.error(`[Offscreen] Failed to initialize ${workerType} worker`);
    throw new Error(`Failed to initialize ${workerType} worker`);
  }

  // If message has a requestId, set up promise for response
  // BUT: For streaming operations (like search), we don't wait for a response
  // The requestId is only used for matching chunks in the streamed responses
  const requestId =
    "requestId" in message && typeof message.requestId === "string" ? message.requestId : undefined;

  // Check if this is a streaming or long-running operation that should be fire-and-forget
  // from the offscreen document's perspective.
  // - search: streams result chunks
  // - import/bulkExport: long-running operations that stream progress
  const isStreamingOperation =
    (workerType === "search" && (message.type === "search" || message.type === "init")) ||
    (workerType === "import" && message.type === "start") ||
    (workerType === "bulkExport" && message.type === "start");

  log.info(`[Offscreen] routeToWorker decision:`, {
    workerType,
    messageType: message.type,
    hasRequestId: !!requestId,
    requestId,
    isStreamingOperation,
    willWaitForResponse: requestId && !isStreamingOperation,
  });

  if (requestId && !isStreamingOperation) {
    log.debug(`[Offscreen] Setting up promise for request with requestId:`, {
      workerType,
      requestId,
      messageType: message.type,
    });
    return new Promise((resolve, reject) => {
      pendingWorkerRequests.set(requestId, { resolve, reject });
      log.debug(`[Offscreen] Stored pending request, total pending: ${pendingWorkerRequests.size}`);

      if (!worker) {
        reject(new Error(`Worker not initialized for ${workerType}`));
        return;
      }
      switch (workerType) {
        case "search":
          log.debug(`[Offscreen] Posting message to search worker:`, {
            requestId,
            messageType: message.type,
            query: "query" in message ? message.query : undefined,
          });
          postMessageWithTransfer(worker, message as SearchWorkerMessage, transferList);
          break;
        case "stats":
          postMessageWithTransfer(worker, message as StatsWorkerMessage, transferList);
          break;
        case "bulkExport":
          postMessageWithTransfer(worker, message as BulkExportWorkerMessage, transferList);
          break;
        case "bulkSync":
          postMessageWithTransfer(worker, message as BulkSyncWorkerMessage, transferList);
          break;
        case "thumbnail":
          postMessageWithTransfer(worker, message as ThumbnailWorkerMessage, transferList);
          break;
        case "import":
          postMessageWithTransfer(worker, message as ImportWorkerMessage, transferList);
          break;
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (pendingWorkerRequests.has(requestId)) {
          log.warn(`[Offscreen] Worker request timeout:`, {
            workerType,
            requestId,
            messageType: message.type,
          });
          pendingWorkerRequests.delete(requestId);
          reject(new Error(`Worker request timeout: ${requestId}`));
        }
      }, 30000);
    });
  } else {
    // Fire-and-forget message (or streaming operation)
    log.info(`[Offscreen] Sending fire-and-forget message to worker:`, {
      workerType,
      messageType: message.type,
      requestId,
      isStreamingOperation,
    });
    if (!worker) {
      log.error(`[Offscreen] Worker is null, cannot post message!`);
      throw new Error(`Worker not initialized for ${workerType}`);
    }
    switch (workerType) {
      case "search":
        log.info(`[Offscreen] Posting streaming search message to worker:`, {
          requestId,
          messageType: message.type,
          query: "query" in message ? message.query : undefined,
          hasWorker: !!worker,
        });
        postMessageWithTransfer(worker, message as SearchWorkerMessage, transferList);
        log.info(`[Offscreen] Message posted to search worker successfully`);
        break;
      case "stats":
        postMessageWithTransfer(worker, message as StatsWorkerMessage, transferList);
        break;
      case "bulkExport":
        postMessageWithTransfer(worker, message as BulkExportWorkerMessage, transferList);
        break;
      case "bulkSync":
        postMessageWithTransfer(worker, message as BulkSyncWorkerMessage, transferList);
        break;
      case "thumbnail":
        postMessageWithTransfer(worker, message as ThumbnailWorkerMessage, transferList);
        break;
      case "import":
        postMessageWithTransfer(worker, message as ImportWorkerMessage, transferList);
        break;
    }
    return undefined;
  }
}

/**
 * Handle worker request from service worker
 */
async function handleWorkerRequest(message: OffscreenWorkerRequest): Promise<OffscreenResponse> {
  const { workerType, operation, data, requestId } = message;

  log.info(`[Offscreen] handleWorkerRequest called:`, {
    workerType,
    operation,
    requestId,
    hasData: !!data,
    dataKeys: data ? Object.keys(data) : [],
  });

  // Merge operation and data into a single message for the worker
  // If data already has a type, use it; otherwise use operation
  // Spread data first, then override with operation type and requestId
  const workerMessage:
    | SearchWorkerMessage
    | StatsWorkerMessage
    | BulkExportWorkerMessage
    | BulkSyncWorkerMessage
    | ThumbnailWorkerMessage
    | ImportWorkerMessage = {
    ...data, // Spread existing data properties first
    type: operation as string, // Override type with operation
    ...(requestId ? { requestId } : {}), // Add requestId if present
  } as
    | SearchWorkerMessage
    | StatsWorkerMessage
    | BulkExportWorkerMessage
    | BulkSyncWorkerMessage
    | ThumbnailWorkerMessage
    | ImportWorkerMessage;

  log.info(`[Offscreen] Constructed worker message:`, {
    workerType,
    operation,
    topLevelRequestId: requestId,
    messageType: workerMessage.type,
    hasRequestId: "requestId" in workerMessage,
    workerMessageRequestId:
      "requestId" in workerMessage
        ? (workerMessage as { requestId?: string }).requestId
        : undefined,
    dataKeys: data ? Object.keys(data) : [],
  });

  let transferList: Transferable[] | undefined;

  if (
    workerType === "import" &&
    "stagedFilePath" in (workerMessage as ImportWorkerMessage) &&
    typeof (workerMessage as ImportWorkerMessage).stagedFilePath === "string"
  ) {
    const msg = workerMessage as ImportWorkerMessage & {
      stagedFilePath: string;
    };
    log.info("[Offscreen] Preparing staged file for import worker:", {
      operation,
      stagedFilePath: msg.stagedFilePath,
    });
    const stagedFile = await readFileFromOpfs(msg.stagedFilePath);
    const name = msg.originalFileName || stagedFile.name || "import.zip";
    const type = msg.originalFileType || stagedFile.type || "application/octet-stream";
    msg.file = new File([stagedFile], name, { type });
    delete msg.stagedFilePath;
  }

  try {
    log.info(`[Offscreen] About to route message to worker:`, {
      workerType,
      requestId,
      hasTransferList: !!transferList,
      operation,
      messageType: workerMessage.type,
      hasRequestIdInMessage: "requestId" in workerMessage,
    });
    const result = await routeToWorker(workerType, workerMessage, transferList);
    log.info(`[Offscreen] routeToWorker returned:`, {
      workerType,
      requestId,
      operation,
      hasResult: result !== undefined,
    });
    // For fire-and-forget messages (including streaming), result will be undefined
    log.debug(`[Offscreen] Worker request completed:`, {
      workerType,
      requestId,
      operation,
      hasResult: result !== undefined,
      resultType: result ? typeof result : "undefined",
    });
    const response: OffscreenResponse = {
      success: true,
      result,
      // Only include requestId in response if this was a non-streaming request
      // Streaming requests don't get a direct response
      ...(requestId && operation !== "search" ? { requestId } : {}),
    };
    return response;
  } catch (error: unknown) {
    log.error(`[Offscreen] Worker request failed:`, {
      workerType,
      requestId,
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    const response: OffscreenResponse = {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      ...(requestId ? { requestId } : {}),
    };
    return response;
  }
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  // Type guard to ensure message is an OffscreenRequest
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return false;
  }

  const request = message as OffscreenRequest;
  // log.debug("[Offscreen] Received message:", request.type);

  if (request.type === "deleteStagedFile") {
    deleteFileFromOpfs(request.path)
      .then(() => sendResponse({ success: true }))
      .catch((error: unknown) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (request.type === "createBlobUrl") {
    getFile(request.path)
      .then((file) => {
        if (!file) {
          throw new Error(`OPFS file not found: ${request.path}`);
        }
        const url = URL.createObjectURL(file);
        sendResponse({ success: true, url });
      })
      .catch((error: unknown) =>
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    return true;
  }

  if (request.type === "revokeBlobUrl") {
    URL.revokeObjectURL(request.url);
    sendResponse({ success: true, url: request.url });
    return true;
  }

  if (request.type === "createIframe") {
    createIframe(request.url)
      .then(() => {
        const response: OffscreenResponse = {
          success: true,
          iframeInfo: getIframeInfo(),
        };
        sendResponse(response);
      })
      .catch((error) => {
        const response: OffscreenResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        sendResponse(response);
      });
    return true; // async response
  }

  if (request.type === "navigateIframe") {
    navigateIframe(request.url)
      .then(() => {
        const response: OffscreenResponse = {
          success: true,
          iframeInfo: getIframeInfo(),
        };
        sendResponse(response);
      })
      .catch((error) => {
        const response: OffscreenResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        sendResponse(response);
      });
    return true; // async response
  }

  if (request.type === "getIframeInfo") {
    const response: OffscreenResponse = {
      success: true,
      iframeInfo: getIframeInfo(),
    };
    sendResponse(response);
    return true;
  }

  if (request.type === "ping") {
    const response: OffscreenResponse = {
      success: true,
      ready: iframeReady,
      iframeInfo: getIframeInfo(),
    };
    sendResponse(response);
    return true;
  }

  if (request.type === "workerRequest") {
    handleWorkerRequest(request)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        const response: OffscreenResponse = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
        sendResponse(response);
      });
    return true; // async response
  }

  return false;
});
