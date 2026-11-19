/**
 * Media Storage Service
 *
 * High-level service for managing media files (images, videos, documents) in OPFS.
 * Provides a clean API on top of the low-level OPFS utilities.
 *
 * Architecture:
 * - "Warehouse" (OPFS): Stores heavy binary bodies of files
 * - "Catalog" (IndexedDB): Stores metadata + pointer to Warehouse
 *
 * File Structure:
 * media/
 *   {chatId}/
 *     {messageId}_0.jpg
 *     {messageId}_1.png
 *     ...
 */

import { log } from "../utils/logger";
import * as OPFS from "../utils/opfs";

/** The OPFS directory that holds every chat's media folder. Nothing else lives in it. */
export const MEDIA_ROOT_PATH = "media";

/** The folder name a chat's media goes in: the chat id with the characters a path cannot hold replaced. */
export function mediaFolderName(chatId: string): string {
  return chatId.replace(/[/\\:*?"<>|]/g, "_");
}

/**
 * Reference to a stored media file
 * Stored in IndexedDB mediaContent table
 */
export interface StoredMediaReference {
  storagePath: string; // e.g., "media/chat-123/msg-456_0.jpg"
  mimeType: string;
  size: number;
  originalName?: string;
}

/**
 * Media Storage Service Interface
 */
export interface MediaStorageService {
  /**
   * Saves binary data to OPFS
   * Optimized for Worker usage via SyncAccessHandle
   */
  save(
    chatId: string,
    messageId: string,
    blob: Blob | ArrayBuffer,
    extension: string,
    index?: number,
  ): Promise<StoredMediaReference>;

  /**
   * Finds the file an earlier sync stored for this message and index, whatever extension it was
   * saved under (`{messageId}_{index}.jpg`, `.png`, ...). Answers null when there is none.
   *
   * A file of zero bytes is not a file: a write that failed leaves one behind. When more than one
   * file matches (the same asset came back under another type), the most recently written wins.
   */
  findStored(
    chatId: string,
    messageId: string,
    index: number,
  ): Promise<StoredMediaReference | null>;

  /**
   * Retrieves a file handle
   * Lightweight - does not load content into memory
   */
  getHandle(storagePath: string): Promise<FileSystemFileHandle | null>;

  /**
   * Generates a temporary Object URL for UI rendering
   * The consumer is responsible for revoking it
   */
  createObjectURL(storagePath: string): Promise<string | null>;

  /**
   * Deletes a file
   */
  delete(storagePath: string): Promise<void>;

  /**
   * Deletes a directory of files (e.g., deleting a chat).
   * Resolves true when the directory is gone (or never was), false when it could not be removed:
   * the folder is then left for the media sweep, which finds it unreferenced.
   */
  deleteChatDir(chatId: string): Promise<boolean>;

  /**
   * Reads file content as ArrayBuffer
   * Use sparingly - prefer getHandle() or createObjectURL() when possible
   */
  read(storagePath: string): Promise<ArrayBuffer | null>;

  /**
   * Get statistics about OPFS media storage
   * Useful for debugging and monitoring
   */
  getStats(): Promise<{
    totalChats: number;
    totalFiles: number;
    estimatedSize: number;
  }>;
}

/**
 * Implementation of Media Storage Service
 */
class MediaStorageServiceImpl implements MediaStorageService {
  private readonly mediaRootPath = MEDIA_ROOT_PATH;

  /**
   * Generate storage path for a media file
   *
   * Format: media/{chatId}/{messageId}_{index}.{extension}
   */
  private generatePath(
    chatId: string,
    messageId: string,
    extension: string,
    index: number = 0,
  ): string {
    // Sanitize chatId and messageId to ensure safe file paths
    const safeChatId = this.sanitizePathSegment(chatId);
    const safeMessageId = this.sanitizePathSegment(messageId);

    // Remove leading dot from extension if present
    const safeExtension = extension.startsWith(".") ? extension.slice(1) : extension;

    return `${this.mediaRootPath}/${safeChatId}/${safeMessageId}_${index}.${safeExtension}`;
  }

  /**
   * Sanitize a path segment to remove potentially unsafe characters
   */
  private sanitizePathSegment(segment: string): string {
    return mediaFolderName(segment);
  }

  /**
   * Extract MIME type from various input formats
   */
  private extractMimeType(data: Blob | ArrayBuffer): string {
    if (data instanceof Blob) {
      return data.type || "application/octet-stream";
    }
    // For ArrayBuffer, we can't determine MIME type, use generic
    return "application/octet-stream";
  }

  /**
   * Extract file size from various input formats
   */
  private extractSize(data: Blob | ArrayBuffer): number {
    if (data instanceof Blob) {
      return data.size;
    }
    return data.byteLength;
  }

  /**
   * Save media to OPFS
   */
  async save(
    chatId: string,
    messageId: string,
    data: Blob | ArrayBuffer,
    extension: string,
    index: number = 0,
  ): Promise<StoredMediaReference> {
    const storagePath = this.generatePath(chatId, messageId, extension, index);
    const mimeType = this.extractMimeType(data);
    const size = this.extractSize(data);

    try {
      // Write to OPFS (will use sync handle in Workers automatically)
      await OPFS.writeFile(storagePath, data);

      return {
        storagePath,
        mimeType,
        size,
      };
    } catch (error) {
      log.error(`[MediaStorage] Failed to save media to OPFS: ${storagePath}`, error);
      throw new Error(
        `Failed to save media: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Find the stored file of a message's media item, whatever its extension.
   */
  async findStored(
    chatId: string,
    messageId: string,
    index: number,
  ): Promise<StoredMediaReference | null> {
    const dirPath = `${this.mediaRootPath}/${this.sanitizePathSegment(chatId)}`;
    // The stem `generatePath` writes; the dot after the index keeps `m_1.` from matching `m_10.`
    const stem = `${this.sanitizePathSegment(messageId)}_${index}.`;

    const names = (await OPFS.listFiles(dirPath)).filter((name) => name.startsWith(stem));

    let best: { reference: StoredMediaReference; lastModified: number } | null = null;
    for (const name of names) {
      const storagePath = `${dirPath}/${name}`;
      const metadata = await OPFS.getFileMetadata(storagePath);
      if (!metadata || metadata.size === 0) continue;
      if (best && best.lastModified >= metadata.lastModified) continue;
      best = {
        lastModified: metadata.lastModified,
        reference: {
          storagePath,
          mimeType: getMimeTypeFromExtension(name.slice(stem.length)) ?? "application/octet-stream",
          size: metadata.size,
        },
      };
    }
    return best?.reference ?? null;
  }

  /**
   * Get file handle without loading content
   */
  async getHandle(storagePath: string): Promise<FileSystemFileHandle | null> {
    try {
      return await OPFS.getFileHandle(storagePath);
    } catch (error) {
      log.error(`[MediaStorage] Failed to get file handle: ${storagePath}`, error);
      return null;
    }
  }

  /**
   * Create a blob URL for rendering in UI
   */
  async createObjectURL(storagePath: string): Promise<string | null> {
    try {
      const file = await OPFS.getFile(storagePath);
      if (!file) {
        log.warn(`[MediaStorage] File not found: ${storagePath}`);
        return null;
      }

      // Create blob URL (caller must revoke it when done)
      return URL.createObjectURL(file);
    } catch (error) {
      log.error(`[MediaStorage] Failed to create object URL: ${storagePath}`, error);
      return null;
    }
  }

  /**
   * Delete a single media file
   */
  async delete(storagePath: string): Promise<void> {
    try {
      const deleted = await OPFS.deleteFile(storagePath);
      if (!deleted) {
        log.warn(`[MediaStorage] File not found for deletion: ${storagePath}`);
      }
    } catch (error) {
      log.error(`[MediaStorage] Failed to delete media: ${storagePath}`, error);
      throw error;
    }
  }

  /**
   * Delete all media files for a chat
   */
  async deleteChatDir(chatId: string): Promise<boolean> {
    const safeChatId = this.sanitizePathSegment(chatId);
    const dirPath = `${this.mediaRootPath}/${safeChatId}`;

    try {
      const deleted = await OPFS.removeDirectory(dirPath);
      if (deleted) {
        log.info(`[MediaStorage] Deleted chat media directory: ${dirPath}`);
      } else {
        log.info(`[MediaStorage] Chat media directory not found: ${dirPath}`);
      }
      return true;
    } catch (error) {
      // Don't throw - deletion failures shouldn't block chat deletion. The chat row is gone by
      // now, so nothing refers to the folder: the media sweep takes it on its next run.
      log.warn(
        `[MediaStorage] Could not delete the media of chat ${chatId} (${dirPath}); the media sweep will remove it`,
        error,
      );
      return false;
    }
  }

  /**
   * Read file content as ArrayBuffer
   * Use sparingly - this loads entire file into memory
   */
  async read(storagePath: string): Promise<ArrayBuffer | null> {
    try {
      return await OPFS.readFile(storagePath);
    } catch (error) {
      log.error(`[MediaStorage] Failed to read file: ${storagePath}`, error);
      return null;
    }
  }

  /**
   * List all media files for a chat
   * Useful for debugging or migration
   */
  async listChatMedia(chatId: string): Promise<string[]> {
    const safeChatId = this.sanitizePathSegment(chatId);
    const dirPath = `${this.mediaRootPath}/${safeChatId}`;

    try {
      const files = await OPFS.listFiles(dirPath);
      return files.map((filename) => `${dirPath}/${filename}`);
    } catch (error) {
      log.error(`[MediaStorage] Failed to list chat media: ${dirPath}`, error);
      return [];
    }
  }

  /**
   * Get statistics about OPFS media storage
   * Useful for debugging and monitoring
   */
  async getStats(): Promise<{
    totalChats: number;
    totalFiles: number;
    estimatedSize: number;
  }> {
    try {
      const chatDirs = await OPFS.listDirectories(this.mediaRootPath);
      let totalFiles = 0;
      let estimatedSize = 0;

      for (const chatDir of chatDirs) {
        const files = await OPFS.listFiles(`${this.mediaRootPath}/${chatDir}`);
        totalFiles += files.length;

        // Estimate size by reading metadata for each file
        for (const file of files) {
          const metadata = await OPFS.getFileMetadata(`${this.mediaRootPath}/${chatDir}/${file}`);
          if (metadata) {
            estimatedSize += metadata.size;
          }
        }
      }

      return {
        totalChats: chatDirs.length,
        totalFiles,
        estimatedSize,
      };
    } catch (error) {
      log.error("[MediaStorage] Failed to get stats", error);
      return { totalChats: 0, totalFiles: 0, estimatedSize: 0 };
    }
  }
}

// Singleton instance
let instance: MediaStorageService | null = null;

/**
 * Get the Media Storage Service instance
 */
export function getMediaStorageService(): MediaStorageService {
  if (!instance) {
    instance = new MediaStorageServiceImpl();
  }
  return instance;
}

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "oga",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/json": "json",
};

/**
 * Helper function to extract extension from MIME type
 *
 * @param mimeType - MIME type (e.g., "image/jpeg")
 * @returns File extension (e.g., "jpg")
 */
export function getExtensionFromMimeType(mimeType: string): string {
  return MIME_TO_EXTENSION[mimeType.toLowerCase()] || "bin";
}

/**
 * The MIME type a stored file's extension stands for, read from the same table the extension came
 * from (the first type listed for an extension wins: `jpg` is `image/jpeg`).
 *
 * @param extension - File extension, with or without the dot (e.g., "jpg")
 * @returns The MIME type, or null for an extension the table does not know (`bin` among them)
 */
export function getMimeTypeFromExtension(extension: string): string | null {
  const wanted = extension.replace(/^\./, "").toLowerCase();
  for (const [mimeType, ext] of Object.entries(MIME_TO_EXTENSION)) {
    if (ext === wanted) return mimeType;
  }
  return null;
}

/**
 * Helper function to detect if content is stored in OPFS vs Base64
 *
 * @param contentData - The content string (OPFS path or Base64 data URL)
 * @returns "opfs" | "base64" | "url"
 */
export function detectContentStorageType(contentData: string): "opfs" | "base64" | "url" {
  if (contentData.startsWith("media/")) {
    return "opfs";
  } else if (contentData.startsWith("data:")) {
    return "base64";
  } else if (contentData.startsWith("http://") || contentData.startsWith("https://")) {
    return "url";
  }
  // Default assumption for unknown formats
  return "base64";
}
