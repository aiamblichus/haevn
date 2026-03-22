/**
 * Media processing utilities for downloading and storing external assets
 *
 * All media is stored in OPFS (Origin Private File System) to prevent IndexedDB bloat.
 * Downloaded assets are saved to OPFS at: media/{chatId}/{messageId}_{index}.{ext}
 *
 * The BinaryContent.data field contains the OPFS path, not base64 data.
 * The viewer converts OPFS paths to blob URLs for display.
 */

import type {
  AudioUrl,
  BinaryContent,
  DocumentUrl,
  ImageUrl,
  UserContent,
  VideoUrl,
} from "../model/haevn_model";
import { getExtensionFromMimeType, getMediaStorageService } from "../services/mediaStorage";
import type { ContentScriptResponse } from "../types/messaging";
import { log } from "./logger";
import { fetchWithTimeout } from "./network_utils";

/**
 * Generic interface for URL-based assets that need to be downloaded and converted.
 * All platform-specific file info types can be mapped to this interface.
 */
export interface UrlAsset {
  url: string;
  type?: string;
  name?: string;
}

interface BlobFetchResult {
  base64: string;
  contentType: string;
}

function normalizeAssetUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  // Gemini/Google image URLs sometimes arrive with trailing punctuation from text extraction.
  // Keep this conservative and only strip obvious suffix punctuation.
  if (/(googleusercontent\.com)/i.test(trimmed) && /[):;.,]$/.test(trimmed)) {
    return trimmed.replace(/[):;.,]+$/, "");
  }
  return trimmed;
}

function isGoogleusercontentImageUrl(url: string): boolean {
  return /https?:\/\/[^/]*googleusercontent\.com\//i.test(url);
}

async function waitForTabComplete(tabId: number, timeoutMs = 15000): Promise<void> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error(`Timed out waiting for helper tab ${tabId} to load`));
    }, timeoutMs);

    const onUpdated = (updatedTabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function fetchBlobViaHelperTab(url: string, logPrefix?: string): Promise<BlobFetchResult> {
  let helperTabId: number | null = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    if (!tab.id) {
      throw new Error("Failed to create helper tab");
    }
    helperTabId = tab.id;

    await waitForTabComplete(helperTabId);

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: helperTabId },
      world: "MAIN",
      func: async () => {
        const toResult = (dataUrl: string) => {
          const [header, base64] = dataUrl.split(",");
          const contentType = header.split(":")[1]?.split(";")[0] || "image/png";
          return { base64, contentType };
        };

        const renderToDataUrl = (img: HTMLImageElement): string => {
          const width = img.naturalWidth || img.width;
          const height = img.naturalHeight || img.height;
          if (!width || !height) {
            throw new Error("Image has invalid dimensions");
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) {
            throw new Error("Failed to get 2D canvas context");
          }
          ctx.drawImage(img, 0, 0);
          return canvas.toDataURL("image/png");
        };

        const existing = document.querySelector("img") as HTMLImageElement | null;
        if (existing) {
          if (!existing.complete) {
            await existing.decode().catch(() => undefined);
          }
          return toResult(renderToDataUrl(existing));
        }

        const img = new Image();
        const loadPromise = new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("Failed to load image in helper tab"));
        });
        img.src = window.location.href;
        await loadPromise;
        return toResult(renderToDataUrl(img));
      },
    });

    if (!result?.result) {
      throw new Error("No result returned from helper tab script");
    }

    if (logPrefix) {
      log.info(`${logPrefix} Helper tab fallback succeeded for: ${url}`);
    }
    return result.result as BlobFetchResult;
  } finally {
    if (helperTabId !== null) {
      try {
        await chrome.tabs.remove(helperTabId);
      } catch {
        // no-op
      }
    }
  }
}

/**
 * Options for processing external assets
 */
export interface ProcessExternalAssetsOptions {
  /** Timeout for individual fetch requests in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Overall timeout for the entire operation (fetch + arrayBuffer) in milliseconds (default: 15000) */
  overallTimeoutMs?: number;
  /** Number of retries for each fetch request (default: 3) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 3000) */
  retryDelayMs?: number;
  /** Concurrency limit for downloads (default: 3) */
  concurrency?: number;
  /** Platform-specific logging prefix (e.g., "[Gemini Transformer]\") */
  logPrefix?: string;
  /** Whether to support all media types (video, audio, document) in fallback URLs, or just images (default: true) */
  supportAllMediaTypes?: boolean;
  /**
   * Chat ID for OPFS storage.
   * REQUIRED - all media is stored in OPFS to prevent IndexedDB bloat.
   */
  chatId: string;
  /**
   * Message ID for OPFS storage.
   * REQUIRED - all media is stored in OPFS to prevent IndexedDB bloat.
   */
  messageId: string;
  /**
   * Whether to include credentials (cookies) in the fetch request.
   * Required for authenticated endpoints like Claude's image API.
   */
  credentials?: RequestCredentials;
  /**
   * Optional tab ID to delegate the fetch to.
   * If provided, the fetch will be executed by the content script in that tab
   * (useful for bypassing CORS or strictly checked headers like Referer).
   */
  tabId?: number;
  /**
   * Force helper-tab navigation based extraction (no clipboard/fetch path).
   * Useful for providers where image URLs are navigation-allowed but fetch-blocked.
   */
  helperTabOnly?: boolean;
}

/**
 * Create a fallback URL object based on content type.
 * Returns the appropriate UserContent type (ImageUrl, VideoUrl, AudioUrl, or DocumentUrl).
 */
function createFallbackUrl(
  url: string,
  contentType: string,
  supportAllMediaTypes: boolean,
): UserContent {
  if (contentType.startsWith("image")) {
    return { kind: "image-url", url } as ImageUrl;
  }
  if (supportAllMediaTypes) {
    if (contentType.startsWith("video")) {
      return { kind: "video-url", url } as VideoUrl;
    }
    if (contentType.startsWith("audio")) {
      return { kind: "audio-url", url } as AudioUrl;
    }
  }
  // Default to document-url for unknown types or when supportAllMediaTypes is false
  return { kind: "document-url", url } as DocumentUrl;
}

// Pending worker requests map for Browser API Bridge pattern
const workerPendingRequests = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
>();

/**
 * Handle browser API responses in a worker context.
 * Call this from the worker's onmessage handler when a browserApiResponse is received.
 */
export function handleWorkerResponse(msg: {
  type: string;
  requestId?: string;
  success?: boolean;
  result?: unknown;
  error?: string;
}): void {
  if (msg.type === "browserApiResponse" && msg.requestId) {
    const pending = workerPendingRequests.get(msg.requestId);
    if (pending) {
      workerPendingRequests.delete(msg.requestId);
      if (msg.success) {
        pending.resolve(msg.result);
      } else {
        pending.reject(new Error(msg.error || "Unknown error"));
      }
    }
  }
}

/**
 * Process external assets by downloading them and converting to binary content.
 * Falls back to URL-based content if download fails or times out.
 *
 * This function handles:
 * - Parallel downloading of assets with a concurrency limit
 * - Timeout protection (both per-request and overall)
 * - Binary conversion to base64 OR OPFS storage (depending on options)
 * - Fallback to URL-based content on errors
 *
 * @param assets - Array of URL assets to process
 * @param options - Processing options
 * @returns Promise that resolves to an array of UserContent (BinaryContent or URL-based fallbacks)
 */
export async function processExternalAssets(
  assets: UrlAsset[],
  options: ProcessExternalAssetsOptions = {},
): Promise<UserContent[]> {
  const {
    timeoutMs = 10000,
    overallTimeoutMs = 15000,
    retries = 3,
    retryDelayMs = 3000,
    concurrency = 3,
    logPrefix = "[Media Utils]",
    supportAllMediaTypes = true,
    chatId,
    messageId,
    credentials,
    helperTabOnly = false,
  } = options;

  // OPFS is mandatory - chatId and messageId are required parameters
  const mediaStorage = getMediaStorageService();

  const results: UserContent[] = new Array(assets.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < assets.length) {
      const index = currentIndex++;
      const asset = assets[index];
      const assetUrl = normalizeAssetUrl(asset.url);
      const contentType = asset.type || "image/jpeg";

      // Helper function to create a fallback URL object based on content type
      const createFallback = (): UserContent => {
        return createFallbackUrl(assetUrl, contentType, supportAllMediaTypes);
      };

      try {
        if (logPrefix) {
          log.info(`${logPrefix} Downloading file [${index + 1}/${assets.length}]: ${asset.url}`);
        }

        // Wrap entire download operation in a timeout to prevent hanging
        const downloadOperation = async (): Promise<BinaryContent> => {
          let buffer: ArrayBuffer;
          let finalContentType: string;

          if (options.tabId) {
            let response: ContentScriptResponse;

            // Check if we are in a Service Worker (has chrome.tabs) or a Web Worker
            const isServiceWorker =
              typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.sendMessage;

            if (helperTabOnly) {
              if (!isServiceWorker) {
                throw new Error("Helper-tab-only mode requires service worker context");
              }
              const helperResult = await fetchBlobViaHelperTab(assetUrl, logPrefix);
              response = {
                success: true,
                base64: helperResult.base64,
                contentType: helperResult.contentType,
              };
            } else if (isServiceWorker) {
              // Content Script Fetch Mode
              if (logPrefix) {
                log.info(`${logPrefix} Delegating fetch to content script (tab ${options.tabId})`);
              }
              // Service Worker Context: Direct send
              response = (await new Promise((resolve, reject) => {
                const tid = setTimeout(
                  () => reject(new Error("Content script fetch timed out")),
                  30000,
                );
                const tabId = options.tabId;
                if (!tabId) {
                  clearTimeout(tid);
                  reject(new Error("No tab ID provided"));
                  return;
                }
                chrome.tabs.sendMessage(
                  tabId,
                  {
                    action: "fetchBlob",
                    url: assetUrl,
                    credentials: credentials ?? "include",
                  },
                  (resp: ContentScriptResponse) => {
                    clearTimeout(tid);
                    if (chrome.runtime.lastError) {
                      reject(new Error(chrome.runtime.lastError.message));
                    } else {
                      resolve(resp);
                    }
                  },
                );
              })) as ContentScriptResponse;
            } else {
              // Web Worker Context: Bridge request via Service Worker (CRD-003)
              const requestId = `fetch_${Date.now()}_${Math.random()}`;
              response = (await new Promise((resolve, reject) => {
                const tid = setTimeout(() => {
                  if (workerPendingRequests.has(requestId)) {
                    workerPendingRequests.delete(requestId);
                    reject(new Error("Worker fetch timeout"));
                  }
                }, 30000);

                workerPendingRequests.set(requestId, {
                  resolve: (val) => {
                    clearTimeout(tid);
                    resolve(val);
                  },
                  reject: (err) => {
                    clearTimeout(tid);
                    reject(err);
                  },
                });

                // Post message to main thread requesting API call
                // Matches BulkSyncWorkerResponse type: { type: "requestBrowserAPI", ... }
                self.postMessage({
                  type: "requestBrowserAPI",
                  requestId,
                  api: "tabs",
                  operation: "sendMessage",
                  params: {
                    tabId: options.tabId,
                    message: {
                      action: "fetchBlob",
                      url: assetUrl,
                      credentials: credentials ?? "include",
                    },
                  },
                });
              })) as ContentScriptResponse;
            }

            if (!helperTabOnly && (!response.success || !("base64" in response))) {
              if (isServiceWorker && isGoogleusercontentImageUrl(assetUrl)) {
                if (logPrefix) {
                  log.warn(
                    `${logPrefix} Content-script fetch failed for Google image URL, trying helper tab fallback`,
                  );
                }
                try {
                  const helperResult = await fetchBlobViaHelperTab(assetUrl, logPrefix);
                  response = {
                    success: true,
                    base64: helperResult.base64,
                    contentType: helperResult.contentType,
                  };
                } catch (helperError) {
                  if (logPrefix) {
                    log.error(
                      `${logPrefix} Helper tab fallback failed for ${assetUrl}:`,
                      helperError,
                    );
                  }
                }
              }
            }

            if (!response.success || !("base64" in response)) {
              throw new Error(response.error || "Content script fetch failed");
            }

            finalContentType = response.contentType || contentType;
            // Convert base64 back to ArrayBuffer for uniform processing
            const binaryString = atob(response.base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            buffer = bytes.buffer;
          } else {
            // Background Fetch Mode
            const response = await fetchWithTimeout(assetUrl, {
              timeoutMs,
              credentials,
              retries,
              retryDelayMs,
            });
            if (!response.ok) {
              throw new Error(`Failed to fetch file: ${response.statusText} for url ${assetUrl}`);
            }
            // Use the content type from the response header if available, otherwise use the one from asset
            finalContentType = response.headers.get("content-type") || contentType;
            if (logPrefix) {
              log.info(`${logPrefix} Reading arrayBuffer for: ${assetUrl}`);
            }
            buffer = await response.arrayBuffer();
          }

          // Save to OPFS
          if (logPrefix) {
            log.info(`${logPrefix} Saving to OPFS for: ${assetUrl}`);
          }
          const extension = getExtensionFromMimeType(finalContentType);
          const storedRef = await mediaStorage.save(chatId, messageId, buffer, extension, index);

          if (logPrefix) {
            log.info(
              `${logPrefix} Successfully saved to OPFS: ${storedRef.storagePath} (${(storedRef.size / 1024).toFixed(2)} KB)`,
            );
          }

          return {
            kind: "binary",
            data: storedRef.storagePath, // OPFS path
            media_type: finalContentType,
            identifier: asset.name,
            vendor_metadata: {
              storageType: "opfs",
              size: storedRef.size,
            },
          } as BinaryContent;
        };

        // Add overall timeout for the entire operation (fetch + arrayBuffer)
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(`File download timeout after ${overallTimeoutMs}ms for ${asset.url}`),
              ),
            overallTimeoutMs,
          );
        });

        results[index] = await Promise.race([downloadOperation(), timeoutPromise]);
      } catch (error) {
        if (logPrefix) {
          log.error(`${logPrefix} Error downloading file from ${asset.url}:`, error);
        }
        results[index] = createFallback(); // fallback
      }
    }
  }

  // Start workers
  const workers = Array.from({ length: Math.min(concurrency, assets.length) }, worker);
  await Promise.all(workers);

  return results;
}
