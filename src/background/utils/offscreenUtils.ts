// Utilities for managing offscreen documents
// Offscreen documents are used for Web Worker management

import { log } from "../../utils/logger";
import { withTimeout } from "../../utils/timeout_utils";

const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";

/**
 * Check if offscreen document already exists
 */
async function hasOffscreenDocument(): Promise<boolean> {
  const clients = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return clients.length > 0;
}

/**
 * Create offscreen document if it doesn't exist
 * This document is used for Web Worker management (search indexing, stats calculation, bulk export)
 *
 * Chrome only allows a single offscreen document per extension, so we reuse it.
 */
export async function ensureOffscreenDocument(): Promise<void> {
  // Check if document already exists
  if (await hasOffscreenDocument()) {
    log.info("[OffscreenUtils] Offscreen document already exists, reusing");
    // Wait a bit for it to be ready (in case it was just created)
    await waitForOffscreenReady();
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification:
        "Offscreen document for Web Worker management for CPU-intensive tasks (search indexing, stats calculation, bulk export, thumbnail generation)",
    });
    log.info("[OffscreenUtils] Offscreen document created");
    // Wait for it to be ready before returning
    await waitForOffscreenReady();
  } catch (error: unknown) {
    // If error is "document already exists", that's okay - another call created it
    // This can happen due to race conditions
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("already exists") ||
      errorMessage.includes("single offscreen document")
    ) {
      log.info("[OffscreenUtils] Offscreen document already exists (race condition), reusing");
      // Wait for it to be ready
      await waitForOffscreenReady();
      return;
    }

    // For other errors, log and rethrow
    log.error("[OffscreenUtils] Failed to create offscreen document:", error);
    throw error;
  }
}

/**
 * Wait for offscreen document to be ready to receive messages
 * Pings the document until it responds
 */
async function waitForOffscreenReady(timeout: number = 5000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    try {
      const response = await new Promise<{ success?: boolean } | undefined>((resolve, reject) => {
        chrome.runtime.sendMessage({ type: "ping" }, (response) => {
          if (chrome.runtime.lastError) {
            // Document might not be ready yet
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });

      if (response?.success) {
        log.info("[OffscreenUtils] Offscreen document is ready");
        return;
      }
    } catch (_error) {
      // Document not ready yet, wait and retry
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  // If we get here, document didn't respond in time
  // But we'll still try to use it (might be a transient issue)
  log.warn("[OffscreenUtils] Offscreen document didn't respond to ping, continuing anyway");
}

/**
 * Close offscreen document
 */
export async function closeOffscreenDocument(): Promise<void> {
  if (!(await hasOffscreenDocument())) {
    return;
  }

  try {
    await chrome.offscreen.closeDocument();
    log.info("[OffscreenUtils] Offscreen document closed");
  } catch (error) {
    log.error("[OffscreenUtils] Failed to close offscreen document:", error);
  }
}

export async function createBlobUrlFromOffscreen(path: string): Promise<string> {
  await ensureOffscreenDocument();
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "createBlobUrl", path }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success && "url" in response) {
          resolve(response.url as string);
        } else {
          reject(new Error(response?.error || "Failed to create blob URL"));
        }
      });
    }),
    5000,
    "createBlobUrlFromOffscreen",
  );
}

export async function revokeBlobUrlFromOffscreen(url: string): Promise<void> {
  await ensureOffscreenDocument();
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "revokeBlobUrl", url }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response?.success) {
          resolve();
        } else {
          reject(new Error(response?.error || "Failed to revoke blob URL"));
        }
      });
    }),
    5000,
    "revokeBlobUrlFromOffscreen",
  );
}
