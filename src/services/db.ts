import Dexie, { type Table } from "dexie";
import type { Chat, ChatMessage } from "../model/haevn_model";
import { log } from "../utils/logger";

// Define a partial type for metadata used in the UI, if needed later for explicit typing
// export type ChatMetadata = Pick<Chat, 'id' | 'source' | 'title' | 'lastSyncedTimestamp' | 'syncStatus' | 'providerLastModifiedTimestamp'>;

export interface OpenWebUIInstance {
  id: string;
  baseUrl: string;
  alias: string;
  createdAt: number;
}

export interface ProviderStats {
  id: string; // Provider name or "provider:baseUrl" for Open WebUI instances
  count: number;
  lastUpdated: number;
}

export interface CacheEntry {
  id: string; // Cache key (e.g., "provider-count:chatgpt", "sync-status:claude:some-id")
  value: unknown; // Cached value (number, boolean, object, etc.)
  lastUpdated: number;
  expiresAt?: number; // Optional expiration timestamp
}

export interface Thumbnail {
  id?: number; // Auto-incremented primary key
  chatId: string;
  messageId: string;
  source: string; // Provider name (chatgpt, claude, etc.)
  mediaType: string; // MIME type (image/png, video/mp4, etc.)
  role: "user" | "assistant";
  thumbnail: string; // Base64 data URL
  chatTitle: string;
  timestamp?: number; // Message timestamp
  generatedAt: number; // When thumbnail was generated
}

// New interface for the heavy content (separated from thumbnails for performance)
export interface MediaContent {
  id: number; // Matches the ID from the thumbnails table
  content: string; // Original content (OPFS path, base64 data URL, or HTTP URL)
  storageType?: "opfs" | "base64" | "url"; // Storage type indicator for migration
  mimeType?: string; // MIME type (for OPFS files)
  size?: number; // File size in bytes (for OPFS files)
}

/**
 * A ChatMessage as stored in the chatMessages table.
 * chatId acts as a foreign key to chats.id and is part of the compound primary key.
 */
export type StoredChatMessage = ChatMessage;

export interface ChatMetadataRecord {
  chatId: string; // Primary key — matches chats.id
  title: string;
  description: string;
  synopsis: string;
  categories: string[];
  keywords: string[];
  source: "manual" | "ai" | "unset";
  generatedAt?: number;
  updatedAt: number;
}

export interface MetadataQueueRecord {
  chatId: string; // Primary key
  status: "pending" | "processing" | "failed";
  retries: number;
  addedAt: number;
  lastAttemptAt?: number;
  error?: string;
}

export class HaevnDatabase extends Dexie {
  chats!: Table<Chat, string>; // Primary key 'id' is of type string
  chatMessages!: Table<StoredChatMessage, [string, string]>; // PK: [chatId, id]
  // Store for serialized Lunr index (single-record store)
  lunrIndex!: Table<{ id: string; index?: object; dirty?: boolean }, string>;
  openwebuiInstances!: Table<OpenWebUIInstance, string>;
  providerStats!: Table<ProviderStats, string>; // Deprecated, kept for migration
  cache!: Table<CacheEntry, string>;
  thumbnails!: Table<Thumbnail, number>; // Primary key is auto-incremented number
  mediaContent!: Table<MediaContent, number>; // New table for heavy content
  chatMetadata!: Table<ChatMetadataRecord, string>; // Primary key 'chatId'
  metadataQueue!: Table<MetadataQueueRecord, string>; // Primary key 'chatId'

  constructor() {
    super("HaevnDB"); // Database name
    this.version(1).stores({
      // 'id' is the primary key. Other fields are indexed for faster queries.
      chats: "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus",
    });
    // Version 2: add a dedicated store for the serialized Lunr.js index
    this.version(2)
      .stores({
        chats: "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus",
        lunrIndex: "id", // Only one entry expected (e.g., id === 'main_index')
      })
      .upgrade(() => {
        // If needed, re-index existing chats here.
        // For initial introduction, simply ensure the new store exists.
        log.info("Upgrading HaevnDB to version 2: Adding lunrIndex store.");
      });
    // Version 3: add Open WebUI instances store
    this.version(3)
      .stores({
        chats: "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
      })
      .upgrade(() => {
        log.info("Upgrading HaevnDB to version 3: Adding openwebuiInstances store.");
      });
    // Version 4: add provider stats cache store
    this.version(4)
      .stores({
        chats: "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        providerStats: "id",
      })
      .upgrade(() => {
        log.info("Upgrading HaevnDB to version 4: Adding providerStats store.");
      });
    // Version 5: add compound index [source+sourceId] for efficient lookups
    this.version(5)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        providerStats: "id",
      })
      .upgrade(() => {
        log.info(
          "Upgrading HaevnDB to version 5: Adding compound index [source+sourceId] for efficient chat lookups.",
        );
      });
    // Version 6: rename providerStats to cache and migrate data
    this.version(6)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        providerStats: null, // Remove providerStats store
      })
      .upgrade(async (tx) => {
        log.info("Upgrading HaevnDB to version 6: Migrating providerStats to cache.");
        try {
          // Migrate existing providerStats entries to cache format
          const oldStats = await tx.table("providerStats").toArray();
          for (const stat of oldStats) {
            await tx.table("cache").put({
              id: `provider-count:${stat.id}`,
              value: stat.count,
              lastUpdated: stat.lastUpdated,
            });
          }
          log.info(`Migrated ${oldStats.length} provider stats entries to cache.`);
        } catch (err) {
          log.error("Error migrating providerStats to cache:", err);
        }
      });
    // Version 7: add thumbnails store for gallery feature
    this.version(7)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt",
      })
      .upgrade(() => {
        log.info("Upgrading HaevnDB to version 7: Adding thumbnails store.");
      });
    // Version 8: Add compound indexes for performant filtering+sorting
    this.version(8)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt]",
      })
      .upgrade(() => {
        log.info(
          "Upgrading HaevnDB to version 8: Adding compound indexes for thumbnail filtering+sorting.",
        );
      });
    // Version 9: Split heavy content into separate table for performance
    this.version(9)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt]",
        mediaContent: "id", // Primary key only
      })
      .upgrade(async (tx) => {
        log.info("Upgrading HaevnDB to version 9: Splitting media content into separate table.");

        try {
          // Iterate over all thumbnails to migrate content
          const thumbnails = await tx.table("thumbnails").toArray();
          // Type assertion to access content field that exists in old data
          type ThumbnailWithContent = Thumbnail & { content?: string };
          for (const thumbnail of thumbnails) {
            const thumbnailWithContent = thumbnail as ThumbnailWithContent;
            if (thumbnailWithContent.content && thumbnail.id) {
              // Move content to new table
              await tx.table("mediaContent").add({
                id: thumbnail.id,
                content: thumbnailWithContent.content,
              });
              // Remove content from main record
              await tx.table("thumbnails").update(thumbnail.id, {
                content: undefined,
              });
            }
          }
          log.info(
            `Migrated ${thumbnails.filter((t) => (t as ThumbnailWithContent).content && t.id).length} thumbnail content entries to mediaContent table.`,
          );
        } catch (err) {
          log.error("Error migrating thumbnail content to mediaContent:", err);
        }
      });
    // Version 10: Remove content field from Thumbnail table (content now only in MediaContent table)
    this.version(10)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt]",
        mediaContent: "id",
      })
      .upgrade(async (tx) => {
        log.info("Upgrading HaevnDB to version 10: Removing content field from thumbnails table.");

        try {
          // Get all thumbnails that still have content field
          const thumbnails = await tx.table("thumbnails").toArray();
          let migratedCount = 0;
          let cleanedCount = 0;
          let orphanedCount = 0;

          for (const thumbnail of thumbnails) {
            // Type assertion to access content field that may exist in old data
            const thumbnailWithContent = thumbnail as Thumbnail & {
              content?: string;
            };

            if (thumbnailWithContent.content && thumbnail.id) {
              // Check if content already exists in mediaContent table
              const existingContent = await tx.table("mediaContent").get(thumbnail.id);

              if (!existingContent) {
                // Content wasn't migrated in version 9, migrate it now
                await tx.table("mediaContent").add({
                  id: thumbnail.id,
                  content: thumbnailWithContent.content,
                });
                migratedCount++;
              }

              // Remove content field from thumbnail record
              // Create update object with all fields except content
              const updateData: Partial<Thumbnail> = {
                chatId: thumbnail.chatId,
                messageId: thumbnail.messageId,
                source: thumbnail.source,
                mediaType: thumbnail.mediaType,
                role: thumbnail.role,
                thumbnail: thumbnail.thumbnail,
                chatTitle: thumbnail.chatTitle,
                timestamp: thumbnail.timestamp,
                generatedAt: thumbnail.generatedAt,
              };
              await tx.table("thumbnails").update(thumbnail.id, updateData);
              cleanedCount++;
            } else if (thumbnail.id) {
              // Check for orphaned thumbnails (have ID but no content in either place)
              const existingContent = await tx.table("mediaContent").get(thumbnail.id);
              if (!existingContent) {
                orphanedCount++;
                log.warn(
                  `[DB Migration v10] Thumbnail ${thumbnail.id} has no content in mediaContent table. This may be expected for thumbnails created after v9.`,
                );
              }
            }
          }

          log.info(
            `[DB Migration v10] Cleanup complete: ${migratedCount} entries migrated, ${cleanedCount} content fields removed, ${orphanedCount} thumbnails without content (may be expected).`,
          );
        } catch (err) {
          log.error("Error removing content field from thumbnails:", err);
        }
      });
    // Version 11: Optimize filtering for common Source+Role combination
    // NOTE: This migration may take time for large databases as it builds a compound index.
    // The database is opened lazily (only when getDB() is called or ensureDbInitialized() in workers),
    // so this won't block service worker or worker startup.
    this.version(11)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
        mediaContent: "id",
      })
      .upgrade(() => {
        log.info(
          "Upgrading HaevnDB to version 11: Adding compound index [source+role+generatedAt] for optimized filtering.",
        );
        // Note: Index creation happens automatically by Dexie during migration.
        // For very large databases, this may take a few seconds, but it's non-blocking
        // since database opening is lazy and happens in response to user actions.
      });

    // Version 12: Add OPFS support for media storage (CRD-004)
    // Introduces storageType field to MediaContent for Base64 → OPFS migration
    this.version(12)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
        mediaContent: "id", // No schema change, but MediaContent interface now includes storageType, mimeType, size
      })
      .upgrade(async (tx) => {
        log.info("Upgrading HaevnDB to version 12: Adding OPFS support for media storage.");

        try {
          // Count existing media content entries for migration planning
          const mediaCount = await tx.table("mediaContent").count();
          log.info(
            `[DB Migration v12] Found ${mediaCount} media content entries to migrate to OPFS.`,
          );

          // Mark all existing entries as "base64" type (assumes current content is Base64 data URLs)
          // This will be used by the migration worker to identify what needs conversion
          const mediaEntries = await tx.table("mediaContent").toArray();
          let markedCount = 0;

          for (const entry of mediaEntries) {
            // Only mark if not already marked (in case of re-run)
            const typedEntry = entry as MediaContent;
            if (!typedEntry.storageType) {
              // Detect storage type from content format
              let storageType: "base64" | "url" = "base64";
              if (
                typedEntry.content.startsWith("http://") ||
                typedEntry.content.startsWith("https://")
              ) {
                storageType = "url";
              }

              await tx.table("mediaContent").update(entry.id, {
                storageType,
              });
              markedCount++;
            }
          }

          log.info(
            `[DB Migration v12] Marked ${markedCount} media entries for migration (${mediaCount - markedCount} already marked).`,
          );

          // Set a flag in cache to trigger migration worker on next startup
          if (mediaCount > 0) {
            await tx.table("cache").put({
              id: "opfs-migration:pending",
              value: true,
              lastUpdated: Date.now(),
            });
            log.info("[DB Migration v12] Migration worker will start on next extension startup.");
          } else {
            log.info("[DB Migration v12] No media to migrate, skipping migration worker.");
          }
        } catch (err) {
          log.error("[DB Migration v12] Error during OPFS migration setup:", err);
        }
      });

    // Version 13: Add compound indexes for optimized chat list sorting/filtering
    // Enables DB-level sorting when filtering by provider, eliminating O(N) in-memory sorts
    this.version(13).stores({
      chats:
        "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title]",
      lunrIndex: "id",
      openwebuiInstances: "id, baseUrl",
      cache: "id",
      thumbnails:
        "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
      mediaContent: "id",
    });

    // Version 14: Add deletedAt index for soft delete functionality
    // Enables efficient queries for soft-deleted chats requiring cleanup by Janitor
    this.version(14).stores({
      chats:
        "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title], deletedAt",
      lunrIndex: "id",
      openwebuiInstances: "id, baseUrl",
      cache: "id",
      thumbnails:
        "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
      mediaContent: "id",
    });

    // Version 16: Add indexed `deleted` field with compound indexes for efficient soft-delete filtering
    // The `deleted` field (0=active, 1=deleted) is always defined, unlike `deletedAt` which may be undefined.
    // This enables compound index queries like [deleted+lastSyncedTimestamp] to skip deleted records
    // at the index level instead of filtering in JavaScript (O(1) vs O(n)).
    // Note: Version 15 was applied but its code was lost; we skip to 16.
    this.version(16)
      .stores({
        chats:
          "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title], deletedAt, deleted, [deleted+lastSyncedTimestamp], [deleted+providerLastModifiedTimestamp], [deleted+title], [deleted+source+lastSyncedTimestamp], [deleted+source+providerLastModifiedTimestamp], [deleted+source+title]",
        lunrIndex: "id",
        openwebuiInstances: "id, baseUrl",
        cache: "id",
        thumbnails:
          "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
        mediaContent: "id",
      })
      .upgrade(async (tx) => {
        log.info(
          "Upgrading HaevnDB to version 16: Adding indexed `deleted` field for efficient soft-delete queries.",
        );

        try {
          const chatsTable = tx.table("chats");
          const totalChats = await chatsTable.count();
          log.info(`[DB Migration v16] Found ${totalChats} chats to update with deleted field.`);

          // Set deleted=0 for active chats, deleted=1 for soft-deleted chats
          let updatedCount = 0;
          await chatsTable.toCollection().modify((chat) => {
            // If deletedAt is set, mark as deleted; otherwise mark as active
            chat.deleted = chat.deletedAt ? 1 : 0;
            updatedCount++;
          });

          log.info(`[DB Migration v16] Updated ${updatedCount} chats with indexed deleted field.`);
        } catch (err) {
          log.error("[DB Migration v16] Error during deleted field migration:", err);
        }
      });

    // Version 17: Extract Chat.messages into dedicated chatMessages table.
    // No upgrade() here by design; data migration runs lazily in background alarm batches.
    this.version(17).stores({
      chats:
        "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title], deletedAt, deleted, [deleted+lastSyncedTimestamp], [deleted+providerLastModifiedTimestamp], [deleted+title], [deleted+source+lastSyncedTimestamp], [deleted+source+providerLastModifiedTimestamp], [deleted+source+title]",
      chatMessages: "[chatId+id], chatId, parentId, timestamp",
      lunrIndex: "id",
      openwebuiInstances: "id, baseUrl",
      cache: "id",
      thumbnails:
        "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
      mediaContent: "id",
    });
    // Version 18: Add chatMetadata and metadataQueue tables for the parallel metadata system
    this.version(18).stores({
      chats:
        "id, source, title, lastSyncedTimestamp, providerLastModifiedTimestamp, syncStatus, [source+sourceId], [source+lastSyncedTimestamp], [source+providerLastModifiedTimestamp], [source+title], deletedAt, deleted, [deleted+lastSyncedTimestamp], [deleted+providerLastModifiedTimestamp], [deleted+title], [deleted+source+lastSyncedTimestamp], [deleted+source+providerLastModifiedTimestamp], [deleted+source+title]",
      chatMessages: "[chatId+id], chatId, parentId, timestamp",
      lunrIndex: "id",
      openwebuiInstances: "id, baseUrl",
      cache: "id",
      thumbnails:
        "++id, chatId, messageId, [chatId+messageId], source, role, mediaType, generatedAt, [source+generatedAt], [role+generatedAt], [mediaType+generatedAt], [source+role+generatedAt]",
      mediaContent: "id",
      chatMetadata: "chatId",
      metadataQueue: "chatId, status, addedAt",
    });
    // Define future versions here with .version(n).stores({}) for schema migrations
  }
}

let _dbInstance: HaevnDatabase | null = null;

export function getDB(): HaevnDatabase {
  if (!_dbInstance) {
    _dbInstance = new HaevnDatabase();
  }
  return _dbInstance;
}
