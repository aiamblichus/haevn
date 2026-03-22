/**
 * Media Handlers
 *
 * Background script handlers for media operations.
 * Provides access to OPFS-stored media files for viewer and other UI components.
 */

import { getMediaStorageService } from "../../services/mediaStorage";
import type { BackgroundRequest, BackgroundResponse } from "../../types/messaging";
import { log } from "../../utils/logger";

const mediaStorage = getMediaStorageService();

//=============================================================================
// Main handler functions (to be registered in the message router)
//=============================================================================

export async function handleGetMediaContent(
  message: Extract<BackgroundRequest, { action: "getMediaContent" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  const result = await getMediaContent({ storagePath: message.storagePath });
  sendResponse({ success: true, ...result });
}

export async function handleDeleteMedia(
  message: Extract<BackgroundRequest, { action: "deleteMedia" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  const result = await deleteMedia({ storagePath: message.storagePath });
  if (result.success) {
    sendResponse({ success: true });
  } else {
    sendResponse({ success: false, error: "Failed to delete media" });
  }
}

export async function handleGetMediaStats(
  _message: Extract<BackgroundRequest, { action: "getMediaStats" }>,
  sendResponse: (response: BackgroundResponse) => void,
): Promise<void> {
  const result = await getMediaStats();
  sendResponse({ success: true, ...result });
}

//=============================================================================
// Internal implementation functions
//=============================================================================

/**
 * Get raw media content as base64
 *
 * Used by the viewer to render images/videos and for exports.
 * Note: This loads the entire file into memory.
 */
async function getMediaContent(message: {
  storagePath: string;
}): Promise<{ content: string | null; mimeType: string | null }> {
  const { storagePath } = message;

  try {
    const buffer = await mediaStorage.read(storagePath);
    if (!buffer) {
      return { content: null, mimeType: null };
    }

    // Convert ArrayBuffer to Base64
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    // Try to detect MIME type from file extension
    const ext = storagePath.split(".").pop()?.toLowerCase();
    const mimeType = getMimeTypeFromExtension(ext || "");

    return { content: base64, mimeType };
  } catch (error) {
    log.error(`[Media Handlers] Failed to read media content for ${storagePath}:`, error);
    return { content: null, mimeType: null };
  }
}

/**
 * Delete a media file from OPFS
 *
 * Rarely used - typically media is deleted when the entire chat is deleted.
 */
async function deleteMedia(message: { storagePath: string }): Promise<{ success: boolean }> {
  const { storagePath } = message;

  try {
    await mediaStorage.delete(storagePath);
    return { success: true };
  } catch (error) {
    log.error(`[Media Handlers] Failed to delete media ${storagePath}:`, error);
    return { success: false };
  }
}

/**
 * Get OPFS storage statistics
 *
 * Useful for debugging and monitoring storage usage.
 */
async function getMediaStats(): Promise<{
  totalChats: number;
  totalFiles: number;
  estimatedSize: number;
}> {
  try {
    return await mediaStorage.getStats();
  } catch (error) {
    log.error("[Media Handlers] Failed to get media stats:", error);
    return { totalChats: 0, totalFiles: 0, estimatedSize: 0 };
  }
}

/**
 * Helper function to detect MIME type from file extension
 */
function getMimeTypeFromExtension(ext: string): string {
  const extToMime: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    oga: "audio/ogg",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
  };

  return extToMime[ext] || "application/octet-stream";
}
