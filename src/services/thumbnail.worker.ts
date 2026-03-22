// Thumbnail Worker - Offloads image processing to prevent blocking the service worker
import Dexie from "dexie";
import { type AttachmentInfo, extractAttachmentsFromChat } from "../formatters";
import type {
  GalleryMediaItem,
  MediaRoleFilter,
  MediaTypeFilter,
  ThumbnailWorkerMessage,
  ThumbnailWorkerResponse,
} from "../types/workerMessages";
import { arrayBufferToBase64 } from "../utils/binary_utils";
import { log } from "../utils/logger";
import type { Thumbnail } from "./db";
import { HaevnDatabase } from "./db";

// Use the shared database class
// Database initialization is lazy (only when ensureDbInitialized() is called),
// so version 11 migration won't block worker startup
const db = new HaevnDatabase();
const MAX_THUMBNAIL_SIZE = 500; // Max width/height for thumbnails

// Lazy database initialization - ensures DB is open before operations
let dbInitialized = false;
let dbInitPromise: Promise<void> | null = null;

async function ensureDbInitialized(): Promise<void> {
  if (dbInitialized) return;
  if (dbInitPromise) return dbInitPromise;

  dbInitPromise = (async () => {
    try {
      // Open database (migrations run here, including version 11 which adds the compound index)
      await db.open();
      dbInitialized = true;
    } catch (error) {
      dbInitPromise = null; // Reset on error so we can retry
      throw error;
    }
  })();

  return dbInitPromise;
}

const VIDEO_PLACEHOLDER_ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MDAiIGhlaWdodD0iNDAwIiB2aWV3Qm94PSIwIDAgNDAwIDQwMCI+PHJlY3Qgd2lkdGg9IjQwMCIgaGVpZ2h0PSI0MDAiIGZpbGw9IiMzMzMiLz48cG9seWdvbiBwb2ludHM9IjE1MCwxMDAgMjgwLDIwMCAxNTAsMzAwIiBmaWxsPSIjZmZmIi8+PC9zdmc+"; // Simple play icon SVG

// Pending video thumbnail requests
const pendingVideoRequests = new Map<
  string,
  { resolve: (url: string) => void; reject: (err: Error) => void }
>();

/**
 * Request a video thumbnail from the offscreen document
 */
async function captureVideoFrameFromOffscreen(
  videoData: ArrayBuffer | string,
  mimeType: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `vid_${Math.random().toString(36).substring(7)}_${Date.now()}`;
    pendingVideoRequests.set(requestId, { resolve, reject });

    // Send request to offscreen (which is our parent)
    const message: ThumbnailWorkerResponse = {
      type: "requestVideoThumbnail",
      requestId,
      videoData,
      mimeType,
    };

    // If videoData is an ArrayBuffer, transfer it for performance
    if (videoData instanceof ArrayBuffer) {
      self.postMessage(message, [videoData]);
    } else {
      self.postMessage(message);
    }

    // Set a timeout to avoid hanging
    setTimeout(() => {
      if (pendingVideoRequests.has(requestId)) {
        pendingVideoRequests.delete(requestId);
        reject(new Error("Video thumbnail request timed out in worker"));
      }
    }, 20000);
  });
}

/**
 * Resize image to thumbnail size using OffscreenCanvas
 */
async function resizeImage(imageData: string, maxSize: number): Promise<string> {
  try {
    // Create an Image from the data URL or URL
    const img = await createImageBitmap(await fetch(imageData).then((r) => r.blob()));

    // Calculate new dimensions (maintain aspect ratio)
    let width = img.width;
    let height = img.height;

    if (width > maxSize || height > maxSize) {
      if (width > height) {
        height = (height * maxSize) / width;
        width = maxSize;
      } else {
        width = (width * maxSize) / height;
        height = maxSize;
      }
    }

    // Create offscreen canvas and draw resized image
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to get canvas context");
    }

    ctx.drawImage(img, 0, 0, width, height);

    // Convert to blob and then to base64
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: 0.75,
    });
    const arrayBuffer = await blob.arrayBuffer();
    // Use optimized binary conversion utility
    const base64 = arrayBufferToBase64(arrayBuffer);
    return `data:image/jpeg;base64,${base64}`;
  } catch (error) {
    log.error("[ThumbnailWorker] Error resizing image:", error);
    // Return original on error
    return imageData;
  }
}

/**
 * Get content URL from attachment
 * Returns either:
 * - OPFS path (e.g., "media/chatId/...") for OPFS-stored content
 * - Base64 data URL for legacy inline content
 * - External URL for URL-based content
 */
function getContentUrl(attachment: AttachmentInfo): string {
  const content = attachment.content;

  // Binary content
  if ("data" in content) {
    // Check if this is OPFS-stored content (path starts with "media/")
    // OPFS content has the storage path in the data field instead of base64
    if (content.data.startsWith("media/")) {
      return content.data; // Return path as-is, getMediaContent will read from OPFS
    }
    // Legacy base64 data - return as data URL
    return `data:${content.media_type};base64,${content.data}`;
  }

  // URL-based content
  if ("url" in content) {
    return content.url;
  }

  return "";
}

/**
 * Generate thumbnails for a single chat
 */
async function generateThumbnailsForChat(
  chatId: string,
): Promise<{ count: number; thumbnails: GalleryMediaItem[] }> {
  try {
    // Get chat from database
    const chat = await db.chats.get(chatId);
    if (!chat) {
      log.warn(`[ThumbnailWorker] Chat ${chatId} not found`);
      return { count: 0, thumbnails: [] };
    }

    // Extract all attachments
    const attachments = extractAttachmentsFromChat(chat);

    // Filter to images and videos only
    const mediaAttachments = attachments.filter(
      (a) => a.mediaType.startsWith("image/") || a.mediaType.startsWith("video/"),
    );

    if (mediaAttachments.length === 0) {
      log.info(`[ThumbnailWorker] No media attachments found in chat ${chatId}`);
      return { count: 0, thumbnails: [] };
    }

    log.info(
      `[ThumbnailWorker] Processing ${mediaAttachments.length} media items for chat ${chatId}`,
    );

    const thumbnails: GalleryMediaItem[] = [];
    let processedCount = 0;

    for (const attachment of mediaAttachments) {
      try {
        const role = attachment.isUserContent ? "user" : "assistant";

        // Prepare content outside transaction (expensive I/O operations)
        const contentRef = getContentUrl(attachment);
        let thumbnailUrl: string;
        let contentUrlForThumbnail = contentRef;

        // If content is stored in OPFS, read and convert to data URL for thumbnail generation
        if (contentRef.startsWith("media/")) {
          try {
            const { getMediaStorageService } = await import("./mediaStorage");
            const mediaStorage = getMediaStorageService();
            const buffer = await mediaStorage.read(contentRef);

            if (buffer) {
              if (attachment.mediaType.startsWith("video/")) {
                try {
                  thumbnailUrl = await captureVideoFrameFromOffscreen(buffer, attachment.mediaType);
                } catch (err) {
                  log.error("[ThumbnailWorker] Failed to capture video frame:", err);
                  thumbnailUrl = VIDEO_PLACEHOLDER_ICON;
                }
              } else {
                const base64 = arrayBufferToBase64(buffer);
                contentUrlForThumbnail = `data:${attachment.mediaType};base64,${base64}`;
                thumbnailUrl = await resizeImage(contentUrlForThumbnail, MAX_THUMBNAIL_SIZE);
              }
            }
          } catch (opfsError) {
            log.error(`[ThumbnailWorker] Error reading OPFS file ${contentRef}:`, opfsError);
          }
        } else if (attachment.mediaType.startsWith("video/")) {
          // Non-OPFS video (legacy or external URL)
          try {
            thumbnailUrl = await captureVideoFrameFromOffscreen(contentRef, attachment.mediaType);
          } catch (err) {
            log.error("[ThumbnailWorker] Failed to capture video frame for non-OPFS video:", err);
            thumbnailUrl = VIDEO_PLACEHOLDER_ICON;
          }
        }

        // Generate thumbnail based on media type if not already set by logic above
        if (!thumbnailUrl) {
          if (attachment.mediaType.startsWith("image/")) {
            thumbnailUrl = await resizeImage(contentUrlForThumbnail, MAX_THUMBNAIL_SIZE);
          } else {
            // Video (if capture failed or wasn't handled) - use placeholder
            thumbnailUrl = VIDEO_PLACEHOLDER_ICON;
          }
        }

        // Get message timestamp
        const chatMessage = chat.messages[attachment.messageId];
        const timestamp = chatMessage?.timestamp;

        // Transaction to check and write atomically (prevents race condition duplicates)
        const inserted = await db.transaction("rw", db.thumbnails, db.mediaContent, async () => {
          // Check if thumbnail already exists INSIDE the transaction
          // This prevents race conditions when multiple calls run in parallel
          const existing = await db.thumbnails
            .where("[chatId+messageId]")
            .equals([chatId, attachment.messageId])
            .and((t) => t.role === role)
            .first();

          if (existing) {
            log.info(
              `[ThumbnailWorker] Thumbnail already exists for ${chatId}:${attachment.messageId}, skipping`,
            );
            return false;
          }

          // 1. Create thumbnail record (WITHOUT content)
          const thumbnail: Thumbnail = {
            chatId,
            messageId: attachment.messageId,
            source: chat.source,
            mediaType: attachment.mediaType,
            role,
            thumbnail: thumbnailUrl,
            // content is not stored in thumbnails table anymore
            chatTitle: chat.title,
            timestamp,
            generatedAt: Date.now(),
          };

          // Save thumbnail record and get the generated ID
          const thumbnailId = await db.thumbnails.add(thumbnail);

          // 2. Create content record in separate table
          // Store the OPFS path (contentRef), not the converted data URL
          await db.mediaContent.add({
            id: thumbnailId as number,
            content: contentRef,
          });

          // Add to results for UI return
          thumbnails.push({
            id: `${chatId}:${attachment.messageId}:${thumbnailId}`, // Using DB ID in composite key helps uniqueness
            chatId,
            chatTitle: chat.title,
            source: chat.source,
            messageId: attachment.messageId,
            mediaType: attachment.mediaType,
            role,
            thumbnail: thumbnailUrl,
            content: "", // UI fetches this lazy
            timestamp,
          });

          return true;
        });

        if (inserted) {
          processedCount++;
        }
      } catch (error) {
        log.error(`[ThumbnailWorker] Error processing attachment ${attachment.messageId}:`, error);
      }
    }

    log.info(`[ThumbnailWorker] Generated ${processedCount} thumbnails for chat ${chatId}`);
    return { count: processedCount, thumbnails };
  } catch (error) {
    log.error(`[ThumbnailWorker] Error generating thumbnails for chat ${chatId}:`, error);
    throw error;
  }
}

/**
 * Find chats that are missing thumbnails
 */
async function findChatsWithMissingThumbnails(): Promise<string[]> {
  try {
    // Get all chats
    const allChats = await db.chats.toArray();
    const chatsWithMissingThumbnails: string[] = [];

    for (const chat of allChats) {
      // Skip if chat has no ID (shouldn't happen, but TypeScript safety)
      if (!chat.id) continue;

      // Extract attachments
      const attachments = extractAttachmentsFromChat(chat);
      const mediaAttachments = attachments.filter(
        (a) => a.mediaType.startsWith("image/") || a.mediaType.startsWith("video/"),
      );

      if (mediaAttachments.length === 0) continue;

      // Check if thumbnails exist
      const thumbnailCount = await db.thumbnails.where("chatId").equals(chat.id).count();

      if (thumbnailCount === 0) {
        chatsWithMissingThumbnails.push(chat.id);
      }
    }

    log.info(
      `[ThumbnailWorker] Found ${chatsWithMissingThumbnails.length} chats missing thumbnails`,
    );
    return chatsWithMissingThumbnails;
  } catch (error) {
    log.error("[ThumbnailWorker] Error finding missing thumbnails:", error);
    throw error;
  }
}

/**
 * Get thumbnails with filtering and pagination - OPTIMIZED CURSOR METHOD
 *
 * Performance Fix:
 * 1. Uses a manual cursor instead of collection.filter() to avoid loading
 *    heavy Base64 strings into memory for items we are going to skip.
 * 2. Separates the "Count" query (lightweight) from the "Fetch" query.
 */
async function getThumbnails(
  offset: number,
  limit: number,
  filterProvider?: string,
  filterRole?: MediaRoleFilter,
  filterMediaType?: MediaTypeFilter,
  sortBy: string = "generatedAt",
  sortDirection: "asc" | "desc" = "desc",
): Promise<{ items: GalleryMediaItem[]; total: number }> {
  try {
    // 0. Get soft-deleted chat IDs to exclude
    // This is critical for data integrity: Gallery must not show content from deleted chats
    const deletedChatIds = new Set(await db.chats.where("deleted").equals(1).primaryKeys());
    const hasDeletedChats = deletedChatIds.size > 0;

    let collection: Dexie.Collection<Thumbnail, number>;

    // 1. Select Index strategy
    // Check if we have both source and role filters - use compound index if available
    const hasSourceFilter = filterProvider && filterProvider !== "all";
    const hasRoleFilter = filterRole && filterRole !== "all";

    if (hasSourceFilter && hasRoleFilter && sortBy === "generatedAt") {
      // Use compound index [source+role+generatedAt] for optimal performance
      collection = db.thumbnails
        .where("[source+role+generatedAt]")
        .between(
          [filterProvider, filterRole, Dexie.minKey],
          [filterProvider, filterRole, Dexie.maxKey],
        );
    } else if (hasSourceFilter) {
      // Use Compound Index [source+generatedAt] for efficient filtering+sorting
      if (sortBy === "generatedAt") {
        collection = db.thumbnails
          .where("[source+generatedAt]")
          .between([filterProvider, Dexie.minKey], [filterProvider, Dexie.maxKey]);
      } else {
        // Fallback for other sort fields (rare)
        collection = db.thumbnails.where("source").equals(filterProvider);
      }
    } else if (hasRoleFilter) {
      // Use Compound Index [role+generatedAt] for efficient filtering+sorting
      if (sortBy === "generatedAt") {
        collection = db.thumbnails
          .where("[role+generatedAt]")
          .between([filterRole, Dexie.minKey], [filterRole, Dexie.maxKey]);
      } else {
        collection = db.thumbnails.where("role").equals(filterRole);
      }
    } else {
      // No primary filter, just sort
      collection = db.thumbnails.orderBy(sortBy);
    }

    if (sortDirection === "desc") {
      collection = collection.reverse();
    }

    // 2. Define the filter predicate
    const predicate = (t: Thumbnail) => {
      // Exclude soft-deleted chats
      if (deletedChatIds.has(t.chatId)) return false;

      if (filterProvider && filterProvider !== "all" && t.source !== filterProvider) return false;
      if (filterRole && filterRole !== "all" && t.role !== filterRole) return false;
      if (filterMediaType && filterMediaType !== "all") {
        const prefix = filterMediaType === "image" ? "image/" : "video/";
        if (!t.mediaType.startsWith(prefix)) return false;
      }
      return true;
    };

    // 3. Optimized Count
    // We clone the collection for counting so it doesn't affect the fetch cursor
    const countCollection = collection.clone();

    // Dexie's count() with a filter is still somewhat expensive as it must load objects,
    // but there is no way around precise counts without maintaining separate counter tables.
    // Optimization: If no complex JS filtering is needed, Dexie uses the index stats.
    if (!hasSourceFilter && !hasRoleFilter && filterMediaType === "all" && !hasDeletedChats) {
      // Fast path: DB metadata count (no filtering needed AND no deleted chats to exclude)
      // countCollection is already set up correctly
    } else {
      // Slow path: requires filter
      // NOTE: For huge DBs, consider removing 'total' and just using "Has Next Page" logic.
      countCollection.filter(predicate);
    }

    const total = await countCollection.count();

    // 4. Optimized Paging using Cursor
    // We iterate the index. We only accumulate items that match the predicate.
    // We skip until we reach 'offset', take 'limit', then stop.
    const items: GalleryMediaItem[] = [];
    let skipped = 0;
    let taken = 0;

    await collection
      .until(() => taken >= limit)
      .each((t) => {
        // Check filter
        if (!predicate(t)) return;

        // Handle Offset (Skip)
        if (skipped < offset) {
          skipped++;
          return;
        }

        // Handle Limit (Take)
        if (taken < limit) {
          items.push({
            id: `${t.chatId}:${t.messageId}:${t.id}`,
            chatId: t.chatId,
            chatTitle: t.chatTitle,
            source: t.source,
            messageId: t.messageId,
            mediaType: t.mediaType,
            role: t.role,
            thumbnail: t.thumbnail,
            content: "", // Lazy load only
            timestamp: t.timestamp,
          });
          taken++;
        }
      });

    return { items, total };
  } catch (error) {
    log.error("[ThumbnailWorker] Error getting thumbnails:", error);
    throw error;
  }
}

/**
 * Get full content for a specific thumbnail (lazy loading)
 * This fetches the heavy data (Base64 or OPFS) only when needed from the mediaContent table
 */
async function getMediaContent(chatId: string, messageId: string): Promise<string | null> {
  try {
    // First find the thumbnail ID using the index
    const thumb = await db.thumbnails
      .where("[chatId+messageId]")
      .equals([chatId, messageId])
      .first();

    if (!thumb || !thumb.id) return null;

    // Fetch content using the primary key from the mediaContent table
    const mediaItem = await db.mediaContent.get(thumb.id);
    if (!mediaItem || !mediaItem.content) return null;

    const content = mediaItem.content;

    // Check if content is an OPFS path
    if (content.startsWith("media/")) {
      // Read from OPFS and convert to data URL
      try {
        const { getMediaStorageService } = await import("./mediaStorage");
        const mediaStorage = getMediaStorageService();
        const buffer = await mediaStorage.read(content);

        if (!buffer) {
          log.warn(`[ThumbnailWorker] Failed to read OPFS file: ${content}`);
          return null;
        }

        // Convert ArrayBuffer to Base64 using optimized utility
        const base64 = arrayBufferToBase64(buffer);

        // Determine MIME type from extension
        const ext = content.split(".").pop()?.toLowerCase();
        const mimeType = getMimeTypeFromExtension(ext || "");

        return `data:${mimeType};base64,${base64}`;
      } catch (error) {
        log.error(`[ThumbnailWorker] Error reading OPFS file ${content}:`, error);
        return null;
      }
    }

    // Legacy Base64 data (should already be a data URL)
    return content;
  } catch (error) {
    log.error("[ThumbnailWorker] Error getting media content:", error);
    return null;
  }
}

/**
 * Helper to get MIME type from file extension
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
  };
  return extToMime[ext] || "application/octet-stream";
}

/**
 * Generate thumbnails for multiple chats in batches
 */
async function generateBatch(
  chatIds?: string[],
  batchSize: number = 10,
  requestId?: string,
): Promise<{ totalGenerated: number; totalSkipped: number }> {
  try {
    let chatsToProcess: string[];

    if (chatIds && chatIds.length > 0) {
      chatsToProcess = chatIds;
    } else {
      // Find all chats missing thumbnails
      chatsToProcess = await findChatsWithMissingThumbnails();
    }

    log.info(`[ThumbnailWorker] Starting batch generation for ${chatsToProcess.length} chats`);

    let totalGenerated = 0;
    let totalSkipped = 0;

    for (let i = 0; i < chatsToProcess.length; i++) {
      const chatId = chatsToProcess[i];

      try {
        const result = await generateThumbnailsForChat(chatId);
        totalGenerated += result.count;
        totalSkipped += result.count === 0 ? 1 : 0;

        // Send progress update
        const response: ThumbnailWorkerResponse = {
          type: "batchProgress",
          processed: i + 1,
          total: chatsToProcess.length,
          chatId,
          requestId,
        };
        postMessage(response);

        // Throttle to avoid overwhelming the worker
        if (i % batchSize === 0 && i > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (error) {
        log.error(`[ThumbnailWorker] Error processing chat ${chatId}:`, error);
        totalSkipped++;
      }
    }

    log.info(
      `[ThumbnailWorker] Batch complete. Generated: ${totalGenerated}, Skipped: ${totalSkipped}`,
    );
    return { totalGenerated, totalSkipped };
  } catch (error) {
    log.error("[ThumbnailWorker] Error in batch generation:", error);
    throw error;
  }
}

// Initialize worker
log.info("[ThumbnailWorker] Worker initialized");

// Message handler
self.onmessage = async (event: MessageEvent<ThumbnailWorkerMessage>) => {
  const message = event.data;
  const requestId = "requestId" in message ? message.requestId : undefined;

  try {
    switch (message.type) {
      case "init": {
        log.info("[ThumbnailWorker] Initializing...");
        await ensureDbInitialized();
        const response: ThumbnailWorkerResponse = {
          type: "initComplete",
          success: true,
          requestId,
        };
        postMessage(response);
        break;
      }

      case "generateForChat": {
        await ensureDbInitialized();
        const result = await generateThumbnailsForChat(message.chatId);
        const response: ThumbnailWorkerResponse = {
          type: "thumbnailsGenerated",
          chatId: message.chatId,
          count: result.count,
          thumbnails: result.thumbnails,
          requestId,
        };
        postMessage(response);
        break;
      }

      case "generateBatch": {
        await ensureDbInitialized();
        const result = await generateBatch(message.chatIds, message.batchSize, requestId);
        const response: ThumbnailWorkerResponse = {
          type: "batchComplete",
          totalGenerated: result.totalGenerated,
          totalSkipped: result.totalSkipped,
          requestId,
        };
        postMessage(response);
        break;
      }

      case "checkMissing": {
        await ensureDbInitialized();
        const chatIds = await findChatsWithMissingThumbnails();
        const response: ThumbnailWorkerResponse = {
          type: "missingCount",
          requestId: message.requestId,
          count: chatIds.length,
          chatIds,
        };
        postMessage(response);
        break;
      }

      case "getThumbnails": {
        await ensureDbInitialized();
        const result = await getThumbnails(
          message.offset,
          message.limit,
          message.filterProvider,
          message.filterRole,
          message.filterMediaType,
          message.sortBy,
          message.sortDirection,
        );
        const response: ThumbnailWorkerResponse = {
          type: "thumbnailsResult",
          requestId: message.requestId,
          items: result.items,
          total: result.total,
        };
        postMessage(response);
        break;
      }

      case "getMediaContent": {
        await ensureDbInitialized();
        const content = await getMediaContent(message.chatId, message.messageId);
        const response: ThumbnailWorkerResponse = {
          type: "mediaContentResult",
          requestId: message.requestId,
          content: content || "",
        };
        postMessage(response);
        break;
      }

      case "videoThumbnailResponse": {
        const pending = pendingVideoRequests.get(message.requestId);
        if (pending) {
          pendingVideoRequests.delete(message.requestId);
          if (message.error) {
            pending.reject(new Error(message.error));
          } else if (message.thumbnailUrl) {
            pending.resolve(message.thumbnailUrl);
          } else {
            pending.reject(new Error("Empty video thumbnail response"));
          }
        }
        break;
      }

      default:
        log.warn("[ThumbnailWorker] Unknown message type:", message);
    }
  } catch (error) {
    const errorResponse: ThumbnailWorkerResponse = {
      type: "error",
      error: error instanceof Error ? error.message : String(error),
      requestId,
    };
    postMessage(errorResponse);
  }
};
