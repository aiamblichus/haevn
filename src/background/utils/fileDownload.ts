// File download utility for handling file downloads via chrome.downloads API

import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";

export function handleFileDownload(
  message: Extract<BackgroundRequest, { action: "downloadFile" }>,
  sendResponse: (response: BackgroundResponse) => void,
): void {
  try {
    log.info("HAEVN Background: Handling file download request");
    const { content, filename, contentType } = message;

    if (!content || !filename) {
      log.error("Missing content or filename");
      sendResponse({ success: false, error: "Missing content or filename" });
      return;
    }

    log.info("Creating data URL for file:", filename);

    // Properly encode UTF-8 to base64 (handles Unicode correctly)
    // Convert string to UTF-8 bytes, then to base64
    const encoder = new TextEncoder();
    const utf8Bytes = encoder.encode(content);

    // Convert Uint8Array to base64 string
    let binaryString = "";
    for (let i = 0; i < utf8Bytes.length; i++) {
      binaryString += String.fromCharCode(utf8Bytes[i]);
    }
    const base64Content = btoa(binaryString);

    const dataUrl = `data:${contentType || "text/plain;charset=utf-8"};base64,${base64Content}`;
    log.info("Data URL created, length:", dataUrl.length);

    // Download file
    chrome.downloads.download(
      {
        url: dataUrl,
        filename: filename,
        saveAs: false,
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          log.error("Download failed:", chrome.runtime.lastError);
          sendResponse({
            success: false,
            error: chrome.runtime.lastError.message || "Download failed",
          });
        } else {
          log.info("File downloaded successfully:", filename, "Download ID:", downloadId);

          // Increment export count
          chrome.storage.sync.get(["exportCount"], (result) => {
            const newCount = (result.exportCount || 0) + 1;
            chrome.storage.sync.set({ exportCount: newCount });
          });

          sendResponse({ success: true, downloadId });
        }
      },
    );
  } catch (error) {
    log.error("File download error:", error);
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : "Download failed",
    });
  }
}
