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
import {
  getExtensionFromMimeType,
  getMediaStorageService,
  type MediaStorageService,
} from "../services/mediaStorage";
import type { ContentScriptResponse } from "../types/messaging";
import { log } from "./logger";
import { FetchFailedError, fetchWithTimeout, originAndPath } from "./network_utils";

/**
 * Generic interface for URL-based assets that need to be downloaded and converted.
 * All platform-specific file info types can be mapped to this interface.
 */
export interface UrlAsset {
  url: string;
  type?: string;
  name?: string;
  /**
   * The asset's index in OPFS (`{messageId}_{index}.{ext}`), when it is not its position in the
   * list: a caller that leaves an asset out of the list keeps the others where they were.
   */
  index?: number;
  /**
   * Keep this asset as a link on purpose (a search thumbnail, an icon on a host the extension has
   * no permission for). No download is tried, and the link is neither marked nor counted as an
   * unstored file.
   */
  linkOnly?: boolean;
}

function isGenericBinaryMimeType(mimeType: string | undefined | null): boolean {
  if (!mimeType) return true;
  const normalized = mimeType.toLowerCase().split(";")[0].trim();
  return normalized === "application/octet-stream" || normalized === "binary/octet-stream";
}

function resolvePreferredMimeType(
  detectedMimeType: string | undefined | null,
  fallbackMimeType: string,
): string {
  if (isGenericBinaryMimeType(detectedMimeType)) {
    return fallbackMimeType;
  }
  return detectedMimeType || fallbackMimeType;
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

/**
 * The bytes and the declared type of a `data:` URL. Nothing is fetched: it reads the same in the
 * service worker, in a Web Worker and in a page.
 */
function decodeDataUrl(url: string): { buffer: ArrayBuffer; contentType: string | undefined } {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma === -1) {
    throw new Error("Malformed data URL");
  }
  const [mime, ...params] = url.slice(5, comma).split(";");
  const payload = url.slice(comma + 1);
  const bytes = params.includes("base64")
    ? Uint8Array.from(atob(payload), (char) => char.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(payload));
  return { buffer: bytes.buffer, contentType: mime || undefined };
}

/**
 * Options for processing external assets
 */
export interface ProcessExternalAssetsOptions {
  /** Timeout for individual fetch requests in milliseconds (default: 10000) */
  timeoutMs?: number;
  /** Overall timeout for the entire operation (fetch + arrayBuffer) in milliseconds (default: 15000) */
  overallTimeoutMs?: number;
  /**
   * Number of retries for each fetch request (default: 1). Kept low because the download races
   * overallTimeoutMs and cannot cancel fetchWithTimeout: a 429/503 backoff would outlive the race
   * and keep hitting a throttled host (HVN-120).
   */
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
   * "skip" returns the URL fallback for every asset and touches nothing else: no download, no
   * lookup, no write to OPFS. Omitted or "store" is a sync's behaviour.
   */
  media?: "store" | "skip";
}

/**
 * Create a fallback URL object based on content type.
 * Returns the appropriate UserContent type (ImageUrl, VideoUrl, AudioUrl, or DocumentUrl).
 */
function createFallbackUrl(
  url: string,
  contentType: string,
  supportAllMediaTypes: boolean,
  unstored?: string,
): UserContent {
  // The mark says why the file is not stored; a link kept on purpose has none
  const mark = unstored ? { vendor_metadata: { unstored } } : {};
  if (contentType.startsWith("image")) {
    return { kind: "image-url", url, ...mark } as ImageUrl;
  }
  if (supportAllMediaTypes) {
    if (contentType.startsWith("video")) {
      return { kind: "video-url", url, ...mark } as VideoUrl;
    }
    if (contentType.startsWith("audio")) {
      return { kind: "audio-url", url, ...mark } as AudioUrl;
    }
  }
  // Default to document-url for unknown types or when supportAllMediaTypes is false
  return { kind: "document-url", url, ...mark } as DocumentUrl;
}

/**
 * Why a download did not end in a stored file: `fetch_failed`, `http_<status>`, `timeout` or
 * `save_failed`. A short code, never a URL, so it is safe in a log line and in an export.
 */
class DownloadFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function unstoredCodeOf(error: unknown): string {
  if (error instanceof DownloadFailure) return error.code;
  // fetchWithTimeout says what its last attempt did
  if (
    error instanceof FetchFailedError &&
    error.attempts[error.attempts.length - 1]?.outcome === "timed out"
  ) {
    return "timeout";
  }
  return "fetch_failed";
}

/**
 * The codes the parts of a chat carry that were meant to be stored and were not (see
 * `vendor_metadata.unstored`), one for each part. Read from the transform's output, not kept in
 * a variable: two chats can be in transform at once.
 */
export function unstoredMediaCodes(chat: unknown): string[] {
  const codes: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) return; // bytes, dates: nothing to read
    const record = node as Record<string, unknown>;
    const meta = record.vendor_metadata;
    if (
      meta &&
      typeof meta === "object" &&
      typeof (meta as { unstored?: unknown }).unstored === "string"
    ) {
      codes.push((meta as { unstored: string }).unstored);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(chat);
  return codes;
}

/** How many parts of a chat are links because their download failed (not links on purpose). */
export function countUnstoredMedia(chat: unknown): number {
  return unstoredMediaCodes(chat).length;
}

/**
 * The file an earlier sync stored for this message and index, as the content a fresh download
 * would have produced; null when there is no such file (or it cannot be looked up).
 *
 * Every provider's download ends in `processExternalAssets`, so this one lookup covers them all.
 */
async function reuseStoredFile(
  mediaStorage: MediaStorageService,
  chatId: string,
  messageId: string,
  index: number,
  asset: UrlAsset,
  contentType: string,
  logPrefix: string,
): Promise<BinaryContent | null> {
  try {
    const stored = await mediaStorage.findStored(chatId, messageId, index);
    if (!stored) return null;
    if (logPrefix) {
      log.warn(
        `${logPrefix} Download failed for ${originAndPath(asset.url)}; keeping the stored file ${stored.storagePath}`,
      );
    }
    return {
      kind: "binary",
      data: stored.storagePath,
      media_type: resolvePreferredMimeType(stored.mimeType, contentType),
      identifier: asset.name,
      vendor_metadata: {
        storageType: "opfs",
        size: stored.size,
      },
    } as BinaryContent;
  } catch (error) {
    // The lookup must never take the URL fallback away
    if (logPrefix) {
      log.error(
        `${logPrefix} Could not look for a stored file of ${originAndPath(asset.url)}:`,
        error,
      );
    }
    return null;
  }
}

type BlobResponse = Extract<ContentScriptResponse, { base64: string }>;

/** Whether a content script replied to a fetchBlob request with the blob (and not an error). */
function isBlobResponse(response: ContentScriptResponse): response is BlobResponse {
  return "success" in response && response.success && "base64" in response;
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
  options: ProcessExternalAssetsOptions,
): Promise<UserContent[]> {
  const {
    timeoutMs = 10000,
    overallTimeoutMs = 15000,
    retries = 1,
    retryDelayMs = 3000,
    concurrency = 3,
    logPrefix = "[Media Utils]",
    supportAllMediaTypes = true,
    chatId,
    messageId,
    credentials,
  } = options;

  // A read-only caller gets the URL fallbacks and nothing else: the storage service is not even
  // asked for.
  if (options.media === "skip") {
    return assets.map((asset) =>
      createFallbackUrl(
        normalizeAssetUrl(asset.url),
        asset.type || "image/jpeg",
        supportAllMediaTypes,
      ),
    );
  }

  // OPFS is mandatory - chatId and messageId are required parameters
  const mediaStorage = getMediaStorageService();

  const results: UserContent[] = new Array(assets.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < assets.length) {
      const position = currentIndex++;
      const asset = assets[position];
      // where the file lives in OPFS; `position` is where the result goes
      const index = asset.index ?? position;
      const assetUrl = normalizeAssetUrl(asset.url);
      const contentType = asset.type || "image/jpeg";

      // Helper function to create a fallback URL object based on content type
      const createFallback = (unstored?: string): UserContent => {
        return createFallbackUrl(assetUrl, contentType, supportAllMediaTypes, unstored);
      };

      // A link kept on purpose: nothing is fetched, marked or counted
      if (asset.linkOnly) {
        results[position] = createFallback();
        continue;
      }

      try {
        if (logPrefix) {
          log.info(
            `${logPrefix} Downloading file [${position + 1}/${assets.length}]: ${originAndPath(asset.url)}`,
          );
        }

        // Set when the overall timeout wins. A download cannot be cancelled, so it runs to its end, and
        // then writes nothing: the chat holds the link, and a file no part points to would be left in OPFS
        // (HVN-160).
        let timedOut = false;

        // Wrap entire download operation in a timeout to prevent hanging
        const downloadOperation = async (): Promise<BinaryContent> => {
          let buffer: ArrayBuffer;
          let finalContentType: string;

          if (assetUrl.startsWith("data:")) {
            // The bytes are in the URL: no tab, no content script, so a Web Worker can do it too
            const decoded = decodeDataUrl(assetUrl);
            finalContentType = resolvePreferredMimeType(decoded.contentType, contentType);
            buffer = decoded.buffer;
          } else if (options.tabId) {
            let response: ContentScriptResponse;

            // Check if we are in a Service Worker (has chrome.tabs) or a Web Worker
            const isServiceWorker =
              typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.sendMessage;

            if (isServiceWorker) {
              // Content Script Fetch Mode
              if (logPrefix) {
                log.info(`${logPrefix} Delegating fetch to content script (tab ${options.tabId})`);
              }
              // Service Worker Context: Direct send
              response = (await new Promise<unknown>((resolve, reject) => {
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
              response = (await new Promise<unknown>((resolve, reject) => {
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

            if (!isBlobResponse(response)) {
              const reason = "error" in response ? response.error : undefined;
              throw new Error(reason || "Content script fetch failed");
            }

            finalContentType = resolvePreferredMimeType(response.contentType, contentType);
            // Convert base64 back to ArrayBuffer for uniform processing
            const binaryString = atob(response.base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            buffer = bytes.buffer;
          } else {
            // Background Fetch Mode: the extension's own fetch, the same in the service worker and
            // in a Web Worker. It reaches http(s) only: a page's blob: URL is not reachable here.
            if (!/^https?:/i.test(assetUrl)) {
              throw new DownloadFailure("fetch_failed", "Not an http(s) URL");
            }
            const response = await fetchWithTimeout(assetUrl, {
              timeoutMs,
              credentials,
              retries,
              retryDelayMs,
            });
            if (!response.ok) {
              throw new DownloadFailure(
                `http_${response.status}`,
                `Failed to fetch file: ${response.statusText} for url ${originAndPath(assetUrl)}`,
              );
            }
            // Prefer server-declared content type, but ignore generic octet-stream and keep the source hint.
            finalContentType = resolvePreferredMimeType(
              response.headers.get("content-type"),
              contentType,
            );
            if (logPrefix) {
              log.info(`${logPrefix} Reading arrayBuffer for: ${originAndPath(assetUrl)}`);
            }
            buffer = await response.arrayBuffer();
          }

          // The race is already lost: this file would be one no part of the chat points to (HVN-160)
          if (timedOut) {
            throw new DownloadFailure(
              "timeout",
              `The download ended after its timeout; not stored: ${originAndPath(asset.url)}`,
            );
          }

          // Save to OPFS
          if (logPrefix) {
            log.info(`${logPrefix} Saving to OPFS for: ${originAndPath(assetUrl)}`);
          }
          const extension = getExtensionFromMimeType(finalContentType);
          let storedRef: Awaited<ReturnType<MediaStorageService["save"]>>;
          try {
            storedRef = await mediaStorage.save(chatId, messageId, buffer, extension, index);
          } catch (saveError) {
            const reason = saveError instanceof Error ? saveError.message : String(saveError);
            throw new DownloadFailure("save_failed", `Could not save the file: ${reason}`);
          }

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
          setTimeout(() => {
            timedOut = true;
            reject(
              new DownloadFailure(
                "timeout",
                `File download timeout after ${overallTimeoutMs}ms for ${originAndPath(asset.url)}`,
              ),
            );
          }, overallTimeoutMs);
        });

        results[position] = await Promise.race([downloadOperation(), timeoutPromise]);
      } catch (error) {
        if (logPrefix) {
          log.error(`${logPrefix} Error downloading file from ${originAndPath(asset.url)}:`, error);
        }
        // A re-sync that cannot download an asset again must not lose the copy an earlier sync
        // stored at the stable path: it may be the only one left. Only when there is none does the
        // message fall back to the remote URL.
        results[position] =
          (await reuseStoredFile(
            mediaStorage,
            chatId,
            messageId,
            index,
            asset,
            contentType,
            logPrefix,
          )) ?? createFallback(unstoredCodeOf(error));
      }
    }
  }

  // Start workers
  const workers = Array.from({ length: Math.min(concurrency, assets.length) }, worker);
  await Promise.all(workers);

  return results;
}
