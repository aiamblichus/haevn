// Import Worker - Offloads CPU-intensive import parsing, transformation, and saving
// to prevent blocking the service worker
//
// CRD-003: Service Worker as Browser API Bridge
// This worker cannot access Chrome APIs directly. When it needs to perform browser
// operations, it sends requests to the service worker via postMessage.
// The service worker executes the API calls and sends responses back.

import type { Chat } from "../../model/haevn_model";

import * as ChatPersistence from "../../services/chatPersistence";
import { HaevnDatabase } from "../../services/db";
import * as MetadataRepository from "../../services/metadataRepository";
import type {
  ImportSourceType,
  ImportWorkerMessage,
  ImportWorkerResponse,
} from "../../types/workerMessages";
import { log } from "../../utils/logger";
import { errorShape, fileNameShape, messageShape } from "../../utils/logShape";

// Use the shared database class - worker gets its own instance
const db = new HaevnDatabase();

import type { Entry } from "@zip.js/zip.js";
// Import parsers
import {
  countConversationsInZip as countChatGPTConversationsInZip,
  parseChatGPTBackupZip,
} from "../../providers/chatgpt/importer";
// Import transformers
import { transformOpenAIToHaevn } from "../../providers/chatgpt/transformer";
import {
  countClaudeConversationsInZip,
  parseClaudeBackupZip,
} from "../../providers/claude/importer";
import { convertClaudeTranscriptToHaevn } from "../../providers/claude/transformer";
import { parseClaudeCodeJsonl } from "../../providers/claudecode/importer";
import { transformToHaevnChat } from "../../providers/claudecode/transformer";
import { parseCodexJsonl } from "../../providers/codex/importer";
import { transformCodexToHaevnChat } from "../../providers/codex/transformer";
import {
  countOpenRouterRooms,
  isImportableRoom,
  parseOpenRouterExport,
} from "../../providers/openrouter/importer";
import { transformOpenRouterRoomToHaevnChat } from "../../providers/openrouter/transformer";
import {
  countOpenWebUIConversationsInZip,
  parseOpenWebUIBackupZip,
} from "../../providers/openwebui/importer";
import { transformOpenWebUIToHaevn } from "../../providers/openwebui/transformer";
import { parsePiJsonl } from "../../providers/pi/importer";
import { transformPiToHaevnChat } from "../../providers/pi/transformer";
import type {
  ExportManifestChatEntry,
  ExportManifestMediaEntry,
} from "../../services/exportManifest";
import { getExtensionFromMimeType } from "../../services/mediaStorage";
import { sha256Hex, validateAndNormalizeChat } from "../../utils/jsonImporter";
import { abortWritable, createWritableStream } from "../../utils/opfs";
import { createZipReader, readEntryText } from "../../utils/zipReader";
import { rewriteChatMediaRefs } from "./rewriteMediaRefs";

// Worker state
interface WorkerState {
  status: "running" | "paused" | "cancelled";
  /** The start's requestId: the job's pause is answered on it (HVN-64). */
  requestId: string | undefined;
  importType: ImportSourceType;
  overwriteExisting: boolean;
  fileData?: ArrayBuffer;
  file?: File;
  totalChats: number;
  processedChats: number;
  savedChats: number;
  skippedChats: number;
}

let workerState: WorkerState | null = null;

/**
 * Pending browser API requests map for CRD-003 bridge pattern
 * Maps requestId to { resolve, reject, timeout } for promise resolution
 */
const pendingBrowserRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Helper to yield to event loop
 */
const yieldToEventLoop = () => new Promise((resolve) => setTimeout(resolve, 0));

interface HaevnExportManifest {
  haevn_version: string;
  export_version: string;
  export_id: string;
  export_timestamp: string;
  total_chats: number;
  total_media_items: number;
  total_size_bytes: number;
  provider_stats: Record<string, number>;
  chats: ExportManifestChatEntry[];
  media: ExportManifestMediaEntry[];
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[/\\:*?"<>|]/g, "_");
}

function buildMediaStoragePath(
  chatId: string,
  messageId: string,
  partIndex: number,
  mimeType: string,
): string {
  const safeChatId = sanitizePathSegment(chatId);
  const safeMessageId = sanitizePathSegment(messageId);
  const extension = getExtensionFromMimeType(mimeType);
  return `media/${safeChatId}/${safeMessageId}_${partIndex}.${extension}`;
}

/** Write one media file of an export into OPFS. False when the entry is missing or fails. */
async function restoreMediaEntry(
  entries: Map<string, Entry>,
  mediaEntry: ExportManifestMediaEntry,
): Promise<boolean> {
  const entry = entries.get(mediaEntry.path);
  if (!entry || entry.directory) {
    log.warn(`[ImportWorker] Media entry missing: ${mediaEntry.path}`);
    return false;
  }

  try {
    const targetPath = buildMediaStoragePath(
      mediaEntry.chatId,
      mediaEntry.messageId,
      mediaEntry.partIndex,
      mediaEntry.mediaType,
    );
    const writable = await createWritableStream(targetPath);
    try {
      // Note: entry.getData() closes the writable stream internally when done,
      // so we must NOT call writable.close() ourselves
      await entry.getData(writable, { useWebWorkers: false });
    } catch (writeError) {
      // A stream that failed part-way is still open, and holds the file
      await abortWritable(writable);
      throw writeError;
    }
    return true;
  } catch (error) {
    log.warn(`[ImportWorker] Failed to restore media ${mediaEntry.path}:`, error);
    return false;
  }
}

type ImportProgressPayload = {
  processed: number;
  total: number;
  status: string;
  phase?: "counting" | "manifest" | "chats" | "media" | "index";
  processedMedia?: number;
  totalMedia?: number;
  bytesWritten?: number;
  totalBytes?: number;
  requestId?: string;
};

function sendProgress(payload: ImportProgressPayload): void {
  self.postMessage({
    type: "progress",
    ...payload,
  } as ImportWorkerResponse);
}

async function readHaevnExportManifest(input: File | ArrayBuffer): Promise<{
  reader: ReturnType<typeof createZipReader>;
  manifest: HaevnExportManifest;
  entries: Map<string, Entry>;
}> {
  const reader = createZipReader(input);
  try {
    const entries = await reader.getEntries();
    const manifestEntry = entries.find(
      (entry) => !entry.directory && entry.filename.toLowerCase() === "manifest.json",
    );
    if (!manifestEntry) {
      throw new Error("manifest.json not found in export ZIP");
    }
    const manifestText = await readEntryText(manifestEntry);
    const manifest = JSON.parse(manifestText) as HaevnExportManifest;
    const entryMap = new Map(entries.map((entry) => [entry.filename, entry]));
    return { reader, manifest, entries: entryMap };
  } catch (error) {
    await reader.close();
    throw error;
  }
}

/**
 * Count conversations in import source
 */
async function countConversations(
  importType: ImportSourceType,
  fileData?: ArrayBuffer,
  file?: File,
): Promise<number> {
  const input = file ?? fileData;
  if (!input) {
    throw new Error("File data required for counting");
  }

  switch (importType) {
    case "chatgpt_zip":
      return await countChatGPTConversationsInZip(input);
    case "claude_zip":
      return await countClaudeConversationsInZip(input);
    case "openwebui_zip":
      return await countOpenWebUIConversationsInZip(input);
    case "haevn_export_zip": {
      const { reader, manifest } = await readHaevnExportManifest(input);
      await reader.close();
      return manifest.total_chats ?? manifest.chats?.length ?? 0;
    }
    case "claudecode_jsonl":
    case "codex_jsonl":
    case "pi_jsonl":
      // Single JSONL file = single conversation
      return 1;
    case "openrouter_json":
      // One export file holds many rooms; each room is a chat
      return countOpenRouterRooms(await readImportText(input, "OpenRouter"));
    default:
      throw new Error(`Unsupported import type for counting: ${importType}`);
  }
}

/** The text of an import file that is a single text document (a File, or the bytes of one). */
async function readImportText(input: ArrayBuffer | File, label: string): Promise<string> {
  if (input instanceof File) return await input.text();
  if (input instanceof ArrayBuffer) return new TextDecoder("utf-8").decode(input);
  throw new Error(`Invalid file data type for ${label} import`);
}

/**
 * Check if a chat already exists in the database
 */
async function chatExists(chatId: string): Promise<boolean> {
  try {
    const chat = await db.chats.get(chatId);
    return !!chat;
  } catch (error) {
    log.error(`[ImportWorker] Error checking chat existence:`, error);
    return false;
  }
}

/**
 * Process a single chat: save to DB and request post-processing.
 * Resolves with saved: false only for a duplicate that is not being overwritten (a skip).
 * `beforeSave` runs after that decision and before the save, so side effects that belong to a
 * saved chat (its media files) never happen for a skipped one.
 * Throws when the chat has no ID or cannot be saved (a failure), so the caller counts an error.
 */
async function processChat(
  chat: Chat,
  raw: unknown,
  overwriteExisting: boolean,
  requestId?: string,
  beforeSave?: () => Promise<void>,
): Promise<{ saved: boolean; reason?: string }> {
  if (!chat.id) {
    throw new Error("Chat missing ID");
  }

  // Check if chat already exists
  const exists = await chatExists(chat.id);
  const isNewChat = !exists;

  if (exists && !overwriteExisting) {
    return { saved: false, reason: "Chat already exists (not overwriting)" };
  }

  try {
    // Only a chat that is going to be saved gets here: a skipped chat keeps its media untouched.
    await beforeSave?.();

    // Save chat to DB using shared persistence logic
    const result = await ChatPersistence.saveChat(chat, raw);

    log.info(`[ImportWorker] Saved chat: ${result.chatId}`);

    // Seed chatMetadata from haevnMetadata field if present — never overwrite existing
    if (isNewChat) await MetadataRepository.seedFromChat(chat);

    // Send saved notification
    self.postMessage({
      type: "saved",
      chatId: result.chatId,
      result,
      requestId,
    } as ImportWorkerResponse);

    // Request post-processing from service worker (cache, index, thumbnails)
    self.postMessage({
      type: "postProcess",
      chatId: result.chatId,
      result,
      isNewChat,
      requestId,
    } as ImportWorkerResponse);

    return { saved: true };
  } catch (error) {
    log.error(`[ImportWorker] Error saving chat ${chat.id}:`, error);
    throw error;
  }
}

/**
 * Process import from ZIP file
 */
async function processImport(
  importType: ImportSourceType,
  fileData: ArrayBuffer | File,
  overwriteExisting: boolean,
  requestId?: string,
): Promise<void> {
  log.info(`[ImportWorker] Starting import: ${importType}`);

  let total = 0;
  let processed = 0;
  let saved = 0;
  let skipped = 0;
  let errors = 0;

  // Send initial progress
  sendProgress({
    processed: 0,
    total: 0,
    status: "Counting conversations...",
    phase: "counting",
    requestId,
  });

  try {
    // Count conversations
    total = await countConversations(
      importType,
      fileData instanceof File ? undefined : fileData,
      fileData instanceof File ? fileData : undefined,
    );
    log.info(`[ImportWorker] Found ${total} conversations`);

    // Send progress update
    sendProgress({
      processed: 0,
      total,
      status: `Found ${total} conversations. Starting import...`,
      phase: "chats",
      requestId,
    });

    // Process based on import type
    switch (importType) {
      case "chatgpt_zip": {
        const gen = parseChatGPTBackupZip(fileData);
        for await (const item of gen) {
          // Check for cancellation
          if (workerState?.status === "cancelled") {
            break;
          }

          // Wait if paused
          while (workerState?.status === "paused") {
            await yieldToEventLoop();
          }

          processed++;

          try {
            const chat = transformOpenAIToHaevn({
              conversation: item.conversation,
              assets: item.assets,
            });

            const result = await processChat(chat, item.conversation, overwriteExisting, requestId);

            if (result.saved) {
              saved++;
            } else {
              skipped++;
              self.postMessage({
                type: "skipped",
                chatId: chat.id,
                reason: result.reason || "Unknown",
                requestId,
              } as ImportWorkerResponse);
            }
          } catch (error) {
            log.error("[ImportWorker] Error processing ChatGPT chat:", error);
            errors++;
            self.postMessage({
              type: "failed",
              reason: error instanceof Error ? error.message : "Transform error",
              requestId,
            } as ImportWorkerResponse);
          }

          // Send progress update
          sendProgress({
            processed,
            total,
            status: `Processed ${processed}/${total} conversations (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });

          // Yield to event loop every 5 chats
          if (processed % 5 === 0) {
            await yieldToEventLoop();
          }
        }
        break;
      }

      case "claude_zip": {
        const gen = parseClaudeBackupZip(fileData);
        for await (const item of gen) {
          if (workerState?.status === "cancelled") break;
          while (workerState?.status === "paused") await yieldToEventLoop();

          processed++;

          try {
            const chat = await convertClaudeTranscriptToHaevn(item.conversation, {
              projects: item.projects,
            });

            const result = await processChat(chat, item.conversation, overwriteExisting, requestId);

            if (result.saved) {
              saved++;
            } else {
              skipped++;
              const chatId: string | undefined = (chat as Chat).id || undefined;
              self.postMessage({
                type: "skipped",
                chatId,
                reason: result.reason || "Unknown",
                requestId,
              } as ImportWorkerResponse);
            }
          } catch (error) {
            log.error("[ImportWorker] Error processing Claude chat:", error);
            errors++;
            self.postMessage({
              type: "failed",
              reason: error instanceof Error ? error.message : "Transform error",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed ${processed}/${total} conversations (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });

          if (processed % 5 === 0) await yieldToEventLoop();
        }
        break;
      }

      case "openwebui_zip": {
        const gen = parseOpenWebUIBackupZip(fileData);
        for await (const item of gen) {
          if (workerState?.status === "cancelled") break;
          while (workerState?.status === "paused") await yieldToEventLoop();

          processed++;

          try {
            const chat = transformOpenWebUIToHaevn({
              chat: item.conversation,
            });

            const result = await processChat(chat, item.conversation, overwriteExisting, requestId);

            if (result.saved) {
              saved++;
            } else {
              skipped++;
              const chatId: string | undefined = (chat as Chat).id || undefined;
              self.postMessage({
                type: "skipped",
                chatId,
                reason: result.reason || "Unknown",
                requestId,
              } as ImportWorkerResponse);
            }
          } catch (error) {
            log.error("[ImportWorker] Error processing OpenWebUI chat:", error);
            errors++;
            self.postMessage({
              type: "failed",
              reason: error instanceof Error ? error.message : "Transform error",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed ${processed}/${total} conversations (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });

          if (processed % 5 === 0) await yieldToEventLoop();
        }
        break;
      }

      case "haevn_export_zip": {
        const { reader, manifest, entries } = await readHaevnExportManifest(fileData);
        try {
          const chatEntries = Array.isArray(manifest.chats) ? manifest.chats : [];
          const mediaEntries = Array.isArray(manifest.media) ? manifest.media : [];
          const totalMedia = mediaEntries.length;
          const totalBytes = manifest.total_size_bytes || 0;
          let bytesWritten = 0;
          let restoredMedia = 0;

          sendProgress({
            processed,
            total,
            status: "Parsed export manifest.",
            phase: "manifest",
            totalMedia,
            bytesWritten,
            totalBytes,
            requestId,
          });

          sendProgress({
            processed,
            total,
            status: "Importing chats...",
            phase: "chats",
            totalMedia,
            bytesWritten,
            totalBytes,
            requestId,
          });

          for (const chatEntry of chatEntries) {
            if (workerState?.status === "cancelled") break;
            while (workerState?.status === "paused") await yieldToEventLoop();

            processed++;
            const entry = entries.get(chatEntry.file);
            if (!entry || entry.directory) {
              errors++;
              self.postMessage({
                type: "failed",
                chatId: chatEntry.id,
                reason: "Chat entry not found in ZIP",
                requestId,
              } as ImportWorkerResponse);
            } else {
              try {
                const text = await readEntryText(entry);
                const json = JSON.parse(text);
                const chat = validateAndNormalizeChat(json, await sha256Hex(text));

                // Rewrite media references if we have locally restored media for this chat
                // We create a lookup for this specific chat from the global manifest
                const chatMediaMap = new Map<string, Map<number, string>>();
                for (const me of mediaEntries) {
                  if (me.chatId === chat.id) {
                    if (!chatMediaMap.has(me.messageId)) {
                      chatMediaMap.set(me.messageId, new Map());
                    }
                    const targetPath = buildMediaStoragePath(
                      me.chatId,
                      me.messageId,
                      me.partIndex,
                      me.mediaType,
                    );
                    chatMediaMap.get(me.messageId)?.set(me.partIndex, targetPath);
                  }
                }

                if (chatMediaMap.size > 0 && chat.id) {
                  const globalMediaMap = new Map<string, Map<string, Map<number, string>>>();
                  globalMediaMap.set(chat.id, chatMediaMap);
                  rewriteChatMediaRefs(chat, globalMediaMap);
                }

                // The chat's media is written once the import has decided to save the chat (HVN-132), and
                // whole: a cancel is seen between chats, never half-way through one's files
                const chatMedia = mediaEntries.filter((me) => me.chatId === chat.id);
                const result = await processChat(
                  chat,
                  chat,
                  overwriteExisting,
                  requestId,
                  async () => {
                    for (const mediaEntry of chatMedia) {
                      if (await restoreMediaEntry(entries, mediaEntry)) {
                        restoredMedia += 1;
                        bytesWritten += mediaEntry.size || 0;
                      }
                    }
                  },
                );

                if (result.saved) {
                  saved++;
                } else {
                  skipped++;
                  self.postMessage({
                    type: "skipped",
                    chatId: chat.id,
                    reason: result.reason || "Unknown",
                    requestId,
                  } as ImportWorkerResponse);
                }
              } catch (error) {
                log.error("[ImportWorker] Error processing HAEVN export chat:", errorShape(error));
                errors++;
                self.postMessage({
                  type: "failed",
                  chatId: chatEntry.id,
                  reason: error instanceof Error ? error.message : "Transform error",
                  requestId,
                } as ImportWorkerResponse);
              }
            }

            sendProgress({
              processed,
              total,
              status: `Processed ${processed}/${total} conversations (${saved} saved, ${skipped} skipped)`,
              phase: "chats",
              processedMedia: restoredMedia,
              totalMedia,
              bytesWritten,
              totalBytes,
              requestId,
            });

            if (processed % 5 === 0) await yieldToEventLoop();
          }
        } finally {
          await reader.close();
        }
        break;
      }

      case "claudecode_jsonl": {
        // Parse Claude Code JSONL file
        let jsonlText: string;

        // Handle both File and ArrayBuffer inputs
        if (fileData instanceof File) {
          jsonlText = await fileData.text();
        } else if (fileData instanceof ArrayBuffer) {
          const decoder = new TextDecoder("utf-8");
          jsonlText = decoder.decode(fileData);
        } else {
          throw new Error("Invalid file data type for Claude Code import");
        }

        try {
          const extraction = await parseClaudeCodeJsonl(jsonlText);
          const chat = transformToHaevnChat(extraction);

          processed++;

          const result = await processChat(chat, extraction, overwriteExisting, requestId);

          if (result.saved) {
            saved++;
          } else {
            skipped++;
            log.warn(
              `[ImportWorker] Claude Code chat skipped. Chat ID: ${chat.id}, Reason: ${result.reason || "Unknown"}`,
            );
            self.postMessage({
              type: "skipped",
              chatId: chat.id,
              reason: result.reason || "Unknown",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed Claude Code session (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });
        } catch (error) {
          log.error("[ImportWorker] Error processing Claude Code session:", error);
          errors++;
          self.postMessage({
            type: "failed",
            reason: error instanceof Error ? error.message : "Transform error",
            requestId,
          } as ImportWorkerResponse);
        }
        break;
      }

      case "codex_jsonl": {
        let jsonlText: string;

        if (fileData instanceof File) {
          jsonlText = await fileData.text();
        } else if (fileData instanceof ArrayBuffer) {
          const decoder = new TextDecoder("utf-8");
          jsonlText = decoder.decode(fileData);
        } else {
          throw new Error("Invalid file data type for Codex import");
        }

        try {
          const extraction = await parseCodexJsonl(jsonlText);
          const chat = transformCodexToHaevnChat(extraction);

          processed++;

          const result = await processChat(chat, extraction, overwriteExisting, requestId);

          if (result.saved) {
            saved++;
          } else {
            skipped++;
            log.warn(
              `[ImportWorker] Codex chat skipped. Chat ID: ${chat.id}, Reason: ${result.reason || "Unknown"}`,
            );
            self.postMessage({
              type: "skipped",
              chatId: chat.id,
              reason: result.reason || "Unknown",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed Codex session (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });
        } catch (error) {
          log.error("[ImportWorker] Error processing Codex session:", error);
          errors++;
          self.postMessage({
            type: "failed",
            reason: error instanceof Error ? error.message : "Transform error",
            requestId,
          } as ImportWorkerResponse);
        }
        break;
      }

      case "pi_jsonl": {
        let jsonlText: string;

        if (fileData instanceof File) {
          jsonlText = await fileData.text();
        } else if (fileData instanceof ArrayBuffer) {
          const decoder = new TextDecoder("utf-8");
          jsonlText = decoder.decode(fileData);
        } else {
          throw new Error("Invalid file data type for PI import");
        }

        try {
          const extraction = await parsePiJsonl(jsonlText);
          const chat = transformPiToHaevnChat(extraction);

          processed++;

          const result = await processChat(chat, extraction, overwriteExisting, requestId);

          if (result.saved) {
            saved++;
          } else {
            skipped++;
            log.warn(
              `[ImportWorker] PI chat skipped. Chat ID: ${chat.id}, Reason: ${result.reason || "Unknown"}`,
            );
            self.postMessage({
              type: "skipped",
              chatId: chat.id,
              reason: result.reason || "Unknown",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed PI session (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });
        } catch (error) {
          log.error("[ImportWorker] Error processing PI session:", error);
          errors++;
          self.postMessage({
            type: "failed",
            reason: error instanceof Error ? error.message : "Transform error",
            requestId,
          } as ImportWorkerResponse);
        }
        break;
      }

      case "openrouter_json": {
        // One export file holds many rooms; each room is a chat
        const extraction = parseOpenRouterExport(await readImportText(fileData, "OpenRouter"));

        for (const room of extraction.rooms.filter(isImportableRoom)) {
          if (workerState?.status === "cancelled") {
            break;
          }
          while (workerState?.status === "paused") {
            await yieldToEventLoop();
          }

          processed++;

          try {
            const chat = transformOpenRouterRoomToHaevnChat(room, extraction.version);
            const result = await processChat(chat, extraction, overwriteExisting, requestId);

            if (result.saved) {
              saved++;
            } else {
              skipped++;
              log.warn(
                `[ImportWorker] OpenRouter chat skipped. Chat ID: ${chat.id}, Reason: ${result.reason || "Unknown"}`,
              );
              self.postMessage({
                type: "skipped",
                chatId: chat.id,
                reason: result.reason || "Unknown",
                requestId,
              } as ImportWorkerResponse);
            }
          } catch (error) {
            log.error("[ImportWorker] Error processing OpenRouter chat:", error);
            errors++;
            self.postMessage({
              type: "failed",
              reason: error instanceof Error ? error.message : "Transform error",
              requestId,
            } as ImportWorkerResponse);
          }

          sendProgress({
            processed,
            total,
            status: `Processed ${processed}/${total} OpenRouter chats (${saved} saved, ${skipped} skipped)`,
            phase: "chats",
            requestId,
          });

          if (processed % 5 === 0) await yieldToEventLoop();
        }
        break;
      }

      default:
        throw new Error(`Unsupported import type: ${importType}`);
    }

    // Check final status
    if (workerState?.status === "cancelled") {
      self.postMessage({
        type: "cancelled",
        requestId,
      } as ImportWorkerResponse);
    } else {
      self.postMessage({
        type: "complete",
        processed,
        saved,
        skipped,
        errors,
        requestId,
      } as ImportWorkerResponse);
    }
  } catch (error) {
    log.error("[ImportWorker] Error during import:", errorShape(error));
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      requestId,
    } as ImportWorkerResponse);
  } finally {
    workerState = null;
    // Clean up any pending browser API requests
    for (const [_reqId, pending] of pendingBrowserRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Import operation terminated"));
    }
    pendingBrowserRequests.clear();
  }
}

// Message handler
self.onmessage = async (event: MessageEvent<ImportWorkerMessage>) => {
  const msg = event.data;
  const requestId = msg.requestId;

  // Debug logging
  log.debug("[ImportWorker] Received message:", {
    type: msg.type,
    typeOf: typeof msg.type,
    keys: Object.keys(msg),
    hasFile: "file" in msg,
    requestId,
  });

  try {
    switch (msg.type) {
      case "start": {
        // HVN-55: a job that is running, paused or winding down after a cancel owns
        // workerState until its finally clears it. A second start would overwrite it, so refuse
        // it and leave the state alone.
        if (workerState) {
          self.postMessage({
            type: "error",
            error: "An import is already running in the worker.",
            requestId,
          } as ImportWorkerResponse);
          return;
        }

        if (!msg.fileData?.data && !msg.file) {
          self.postMessage({
            type: "error",
            error: "File data required for import",
            requestId,
          } as ImportWorkerResponse);
          return;
        }

        if (msg.file) {
          log.info("[ImportWorker] Received file:", {
            name: fileNameShape(msg.file.name),
            type: msg.file.type,
            size: msg.file.size,
          });
        } else if (msg.fileData) {
          log.info("[ImportWorker] Received fileData:", {
            name: fileNameShape(msg.fileData.name),
            type: msg.fileData.type,
            size: msg.fileData.size,
            dataByteLength: msg.fileData.data.byteLength,
          });
        }

        // Initialize state
        workerState = {
          status: "running",
          requestId,
          importType: msg.importType,
          overwriteExisting: msg.overwriteExisting,
          fileData: msg.fileData?.data,
          file: msg.file,
          totalChats: 0,
          processedChats: 0,
          savedChats: 0,
          skippedChats: 0,
        };

        // Start processing
        const input = msg.file ?? msg.fileData?.data;
        if (!input) {
          throw new Error("File data required for import");
        }
        await processImport(msg.importType, input, msg.overwriteExisting, requestId);
        break;
      }

      case "count": {
        if (!msg.fileData?.data && !msg.file) {
          self.postMessage({
            type: "error",
            error: "File data required for counting",
            requestId,
          } as ImportWorkerResponse);
          return;
        }

        const count = await countConversations(msg.importType, msg.fileData?.data, msg.file);
        self.postMessage({
          type: "count",
          count,
          requestId,
        } as ImportWorkerResponse);
        break;
      }

      case "pause": {
        if (workerState) {
          workerState.status = "paused";
          // The service worker's pause has no requestId of its own, and `paused` reaches the
          // service worker only on the start's listener, so it is answered on the start's.
          self.postMessage({
            type: "paused",
            requestId: workerState.requestId,
          } as ImportWorkerResponse);
        }
        break;
      }

      case "resume": {
        if (workerState && workerState.status === "paused") {
          workerState.status = "running";
          // Processing will resume on next iteration
        }
        break;
      }

      case "cancel": {
        if (workerState) {
          workerState.status = "cancelled";
          // Worker will detect this and send cancelled message
        }
        break;
      }

      case "browserApiResponse": {
        // CRD-003: Handle browser API responses from service worker
        const pending = pendingBrowserRequests.get(msg.requestId);
        if (!pending) {
          log.warn(
            `[ImportWorker] Received browser API response for unknown requestId: ${msg.requestId}`,
          );
          break;
        }

        clearTimeout(pending.timeout);
        pendingBrowserRequests.delete(msg.requestId);

        if (msg.success) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || "Browser API request failed"));
        }
        break;
      }

      default: {
        const exhaustiveCheck: never = msg;
        log.error("[ImportWorker] Unknown message type:", messageShape(exhaustiveCheck));
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${exhaustiveCheck}`,
          requestId,
        } as ImportWorkerResponse);
      }
    }
  } catch (error) {
    log.error("[ImportWorker] Error handling message:", errorShape(error));
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      requestId,
    } as ImportWorkerResponse);
  }
};
