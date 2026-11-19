// Bulk Export Worker - Offloads CPU-intensive ZIP generation and data processing
// to prevent blocking the service worker
//
// CRD-003: Service Worker as Browser API Bridge
// This worker cannot access Chrome APIs directly. When it needs to perform browser
// operations (e.g., download files), it sends requests to the service worker via
// postMessage. The service worker executes the API calls and sends responses back.
// See browserApiBridge.ts for the bridge implementation.

import type { ExportOptions } from "../../formatters";
import {
  downloadUrlAttachment,
  extractAttachmentsFromChat,
  generateAttachmentFilename,
} from "../../formatters";
import type { Chat, ChatMessage } from "../../model/haevn_model";
import { isHeldForMove } from "../../services/chatPersistence";
import { HaevnDatabase } from "../../services/db";
import { ExportManifestWriter } from "../../services/exportManifest";
import {
  buildExportChatsPath,
  buildExportMediaPath,
  buildExportStagingRoot,
  buildExportZipPath,
  ensureExportStagingDirectories,
} from "../../services/exportStaging";
import {
  BULK_EXPORT_MANIFEST_STATUS,
  BULK_EXPORT_ZIP_STATUS,
  type BulkExportWorkerMessage,
  type BulkExportWorkerResponse,
} from "../../types/workerMessages";
import { log } from "../../utils/logger";
import {
  createWritableStream,
  getFile,
  listDirectories,
  listFiles,
  writeFile,
} from "../../utils/opfs";

// Use the shared database class - worker gets its own instance
const db = new HaevnDatabase();

// Worker state
interface WorkerState {
  status: "running" | "paused" | "cancelled";
  /** The start's requestId: what every message the job posts is answered on. */
  requestId: string | undefined;
  remainingChatIds: string[];
  options: ExportOptions;
  currentBatchNumber: number;
  totalBatches: number;
  totalChats: number;
  processedChats: number;
  skippedCount: number;
  /** Of the skipped, the chats whose messages had not moved to the table yet (HVN-31). */
  unmovedCount: number;
  globalAttachmentIndex: number;
  exportId: string;
  meta: {
    haevnVersion: string;
    exportVersion: string;
    exportTimestamp: string;
  };
  manifestWriter: ExportManifestWriter;
  providerStats: Record<string, number>;
  totalMediaItems: number;
  totalSizeBytes: number;
  processedMedia: number;
}

let workerState: WorkerState | null = null;

const BATCH_SIZE = 100;

/**
 * Pending download requests map for CRD-003 bridge pattern
 * Maps requestId to { resolve, reject, timeout } for promise resolution
 */
const pendingDownloadRequests = new Map<
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

/**
 * Helper to generate ZIP filename with batch info
 */
const textEncoder = new TextEncoder();
const ZIP_BUILD_TIMEOUT_MS = 10 * 60 * 1000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = self.setTimeout(() => {
      reject(new Error(`Timeout: ${label}`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}

async function copyOpfsFile(sourcePath: string, destPath: string): Promise<number> {
  const file = await getFile(sourcePath);
  if (!file) {
    throw new Error(`OPFS source missing: ${sourcePath}`);
  }
  const writable = await createWritableStream(destPath);
  await file.stream().pipeTo(writable);
  return file.size;
}

async function stageBinaryContent(
  exportId: string,
  chatId: string,
  filename: string,
  data: string,
  isBase64: boolean,
): Promise<number> {
  const destPath = buildExportMediaPath(exportId, chatId, filename);
  if (isBase64) {
    const binaryData = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    await writeFile(destPath, binaryData);
    return binaryData.byteLength;
  }
  const encoded = textEncoder.encode(data);
  await writeFile(destPath, encoded);
  return encoded.byteLength;
}

async function stageAttachment(
  exportId: string,
  chatId: string,
  attachment: ReturnType<typeof extractAttachmentsFromChat>[number],
  filename: string,
): Promise<{ bytes: number; mediaType: string }> {
  if (attachment.content.kind === "binary") {
    const contentData = attachment.content.data;
    if (contentData.startsWith("media/")) {
      const bytes = await copyOpfsFile(
        contentData,
        buildExportMediaPath(exportId, chatId, filename),
      );
      return { bytes, mediaType: attachment.content.media_type };
    }
    const isBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(contentData.substring(0, 100));
    const bytes = await stageBinaryContent(exportId, chatId, filename, contentData, isBase64);
    return { bytes, mediaType: attachment.content.media_type };
  }

  const urlContent = attachment.content as { url: string };
  const downloaded = await downloadUrlAttachment(urlContent.url, attachment.mediaType);
  if (!downloaded) {
    throw new Error(`Failed to download attachment from ${urlContent.url}`);
  }
  const bytes = await stageBinaryContent(exportId, chatId, filename, downloaded.data, true);
  return { bytes, mediaType: downloaded.media_type };
}

async function stageChat(chat: Chat, options: ExportOptions, state: WorkerState): Promise<void> {
  if (!chat) {
    return;
  }
  const chatId = chat.id;
  if (!chatId) {
    log.warn(`[BulkExportWorker] Skipping a chat without an id (title: ${chat.title})`);
    return;
  }
  const chatJson = JSON.stringify(chat);
  const chatPath = buildExportChatsPath(state.exportId, chatId);
  const chatBytes = textEncoder.encode(chatJson);
  await writeFile(chatPath, chatBytes);
  state.totalSizeBytes += chatBytes.byteLength;

  await state.manifestWriter.appendChat({
    id: chatId,
    source: chat.source,
    sourceId: chat.sourceId,
    file: `chats/${chatId}.json`,
  });

  state.providerStats[chat.source] = (state.providerStats[chat.source] || 0) + 1;

  const attachments = extractAttachmentsFromChat(chat, options.messageIds);
  for (const attachment of attachments) {
    // A pause waits for the chat boundary (a chat is staged whole); only a cancel cuts it short.
    if (state.status === "cancelled") {
      break;
    }
    const filename = generateAttachmentFilename(
      state.globalAttachmentIndex++,
      attachment.mediaType,
    );
    const attachmentKey = `${attachment.messageId}_${attachment.partIndex}`;
    try {
      const staged = await stageAttachment(state.exportId, chatId, attachment, filename);
      state.processedMedia += 1;
      state.totalMediaItems += 1;
      state.totalSizeBytes += staged.bytes;

      await state.manifestWriter.appendMedia({
        path: `media/${chatId}/${filename}`,
        chatId,
        messageId: attachment.messageId,
        partIndex: attachment.partIndex,
        mediaType: staged.mediaType,
        size: staged.bytes,
      });

      self.postMessage({
        type: "progress",
        processed: state.processedChats,
        total: state.totalChats,
        status: `Staged media ${state.processedMedia}`,
        processedMedia: state.processedMedia,
        bytesWritten: state.totalSizeBytes,
        currentBatch: state.currentBatchNumber,
        totalBatches: state.totalBatches,
      } as BulkExportWorkerResponse);
    } catch (error) {
      log.warn(
        `[BulkExportWorker] Failed to stage attachment ${attachmentKey} for chat ${chatId}:`,
        error,
      );
    }
  }
}

function toMessageDict(rows: ChatMessage[]): Record<string, ChatMessage> {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

/**
 * A chat with its messages from the table. A chat whose messages are still in its row has not been
 * moved (HVN-31): it comes back as "held", since exporting it would write an empty chat.
 */
async function loadChatWithMessages(chatId: string): Promise<Chat | "held" | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;
  if (isHeldForMove(chat)) return "held";

  const rows = await db.chatMessages.where("chatId").equals(chatId).toArray();
  const metadataRecord = await db.chatMetadata.get(chatId);

  const haevnMetadata = metadataRecord
    ? {
        title: metadataRecord.title || undefined,
        description: metadataRecord.description || undefined,
        synopsis: metadataRecord.synopsis || undefined,
        categories: metadataRecord.categories.length > 0 ? metadataRecord.categories : undefined,
        keywords: metadataRecord.keywords.length > 0 ? metadataRecord.keywords : undefined,
      }
    : undefined;

  // The messages are the table's: a row's own `messages` is not read (HVN-31)
  return {
    ...chat,
    messages: toMessageDict(rows),
    ...(haevnMetadata ? { haevnMetadata } : {}),
  };
}

async function writeJsonlArray(
  filePath: string,
  writable: FileSystemWritableFileStream,
): Promise<number> {
  const file = await getFile(filePath);
  if (!file) {
    return 0;
  }

  const reader = file.stream().pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let isFirst = true;
  let count = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const prefix = isFirst ? "" : ",";
      await writable.write(`${prefix}${trimmed}`);
      isFirst = false;
      count += 1;
    }
  }

  const tail = buffer.trim();
  if (tail) {
    const prefix = isFirst ? "" : ",";
    await writable.write(`${prefix}${tail}`);
    count += 1;
  }

  return count;
}

async function buildManifestJson(state: WorkerState): Promise<void> {
  const manifestPath = `${buildExportStagingRoot(state.exportId)}/manifest.json`;
  const writable = await createWritableStream(manifestPath);

  const header = `{"haevn_version":${JSON.stringify(
    state.meta.haevnVersion,
  )},"export_version":${JSON.stringify(
    state.meta.exportVersion,
  )},"export_id":${JSON.stringify(state.exportId)},"export_timestamp":${JSON.stringify(
    state.meta.exportTimestamp,
  )},"total_chats":${state.totalChats},"total_media_items":${
    state.totalMediaItems
  },"total_size_bytes":${state.totalSizeBytes},"provider_stats":${JSON.stringify(
    state.providerStats,
  )},"chats":[`;
  await writable.write(header);

  await writeJsonlArray(`${buildExportStagingRoot(state.exportId)}/manifest/chats.jsonl`, writable);

  await writable.write(`],"media":[`);
  await writeJsonlArray(`${buildExportStagingRoot(state.exportId)}/manifest/media.jsonl`, writable);
  await writable.write(`]}`);
  await writable.close();
}

async function buildZipFromStaging(state: WorkerState): Promise<void> {
  const { ZipWriter, BlobReader } = await import("@zip.js/zip.js");
  const zipStream = new TransformStream();
  const pipePromise = zipStream.readable.pipeTo(
    await createWritableStream(buildExportZipPath(state.exportId)),
  );
  // Critical: Disable zip.js internal web workers since we're already in a worker context.
  // Using nested workers causes deadlocks. Also use level 0 (store) for speed.
  const zipWriter = new ZipWriter(zipStream.writable, {
    useWebWorkers: false,
    level: 0, // Store without compression for maximum speed
  });

  const addFileToZip = async (zipPath: string, opfsPath: string): Promise<void> => {
    const file = await getFile(opfsPath);
    if (!file) {
      log.warn(`[BulkExportWorker] Missing OPFS file for zip entry: ${opfsPath}`);
      return;
    }
    await withTimeout(
      zipWriter.add(zipPath, new BlobReader(file)),
      ZIP_BUILD_TIMEOUT_MS,
      `zip add ${zipPath}`,
    );
  };

  const manifestPath = `${buildExportStagingRoot(state.exportId)}/manifest.json`;
  const chatsPath = `${buildExportStagingRoot(state.exportId)}/chats`;
  const chatFiles = await listFiles(chatsPath);
  const mediaRoot = `${buildExportStagingRoot(state.exportId)}/media`;
  const chatDirs = await listDirectories(mediaRoot);
  let mediaCount = 0;
  const mediaFilesByChat: Record<string, string[]> = {};
  for (const chatDir of chatDirs) {
    const mediaFiles = await listFiles(`${mediaRoot}/${chatDir}`);
    mediaFilesByChat[chatDir] = mediaFiles;
    mediaCount += mediaFiles.length;
  }
  const totalEntries = 1 + chatFiles.length + mediaCount;
  let zippedEntries = 0;

  const reportZipProgress = (label: string) => {
    self.postMessage({
      type: "progress",
      processed: state.processedChats,
      total: state.totalChats,
      status: `${label} (${zippedEntries}/${totalEntries})`,
      processedMedia: state.processedMedia,
      bytesWritten: state.totalSizeBytes,
      currentBatch: state.currentBatchNumber,
      totalBatches: state.totalBatches,
    } as BulkExportWorkerResponse);
  };

  reportZipProgress("Zipping manifest");
  await addFileToZip("manifest.json", manifestPath);
  zippedEntries += 1;

  reportZipProgress("Zipping chats");
  for (const fileName of chatFiles) {
    await addFileToZip(`chats/${fileName}`, `${chatsPath}/${fileName}`);
    zippedEntries += 1;
    if (zippedEntries % 25 === 0 || zippedEntries === totalEntries) {
      reportZipProgress("Zipping chats");
    }
  }

  reportZipProgress("Zipping media");
  for (const chatDir of chatDirs) {
    const mediaFiles = mediaFilesByChat[chatDir] || [];
    for (const fileName of mediaFiles) {
      await addFileToZip(`media/${chatDir}/${fileName}`, `${mediaRoot}/${chatDir}/${fileName}`);
      zippedEntries += 1;
      if (zippedEntries % 50 === 0 || zippedEntries === totalEntries) {
        reportZipProgress("Zipping media");
      }
    }
  }

  await withTimeout(zipWriter.close(), ZIP_BUILD_TIMEOUT_MS, "zip close");
  await withTimeout(pipePromise, ZIP_BUILD_TIMEOUT_MS, "zip pipeTo");
}

/**
 * Clean up all pending browser API requests
 * Called when export operation terminates (complete, cancel, error)
 */
function cleanupPendingRequests(reason: string): void {
  for (const [_reqId, pending] of pendingDownloadRequests.entries()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error(reason));
  }
  pendingDownloadRequests.clear();
}

/**
 * Process a single batch of chats
 */
async function processBatch(
  batchChatIds: string[],
  batchNumber: number,
  totalBatches: number,
  options: ExportOptions,
  globalAttachmentIndex: number,
  state: WorkerState,
): Promise<{
  processedCount: number;
  skippedCount: number;
  /** Of the skipped, the chats whose messages had not moved to the table yet (HVN-31). */
  unmovedCount: number;
  /** How many of batchChatIds were dealt with, from the front: staged, missing or failed. */
  consumedCount: number;
  nextAttachmentIndex: number;
}> {
  log.info(
    `[BulkExportWorker] Processing batch ${batchNumber}/${totalBatches} (${batchChatIds.length} chats)...`,
  );

  let batchProcessedCount = 0;
  let batchSkippedCount = 0;
  let batchUnmovedCount = 0;
  let batchConsumedCount = 0;
  const attachmentIndex = globalAttachmentIndex;

  // Process each chat in the batch
  for (let i = 0; i < batchChatIds.length; i++) {
    if (state.status !== "running") {
      break;
    }
    const chatId = batchChatIds[i];
    const chat = await loadChatWithMessages(chatId);

    if (!chat) {
      log.warn(`[BulkExportWorker] Chat ${chatId} not found, skipping`);
      batchSkippedCount++;
      batchConsumedCount++;
      continue;
    }

    if (chat === "held") {
      log.warn(
        `[BulkExportWorker] Chat ${chatId} has messages not moved to the new layout yet, skipping`,
      );
      batchSkippedCount++;
      batchUnmovedCount++;
      batchConsumedCount++;
      continue;
    }

    try {
      log.info(
        `[BulkExportWorker] Processing chat ${i + 1}/${
          batchChatIds.length
        } in batch ${batchNumber}: ${chatId}`,
      );

      await stageChat(chat, options, state);

      batchProcessedCount++;
      state.processedChats += 1;
      self.postMessage({
        type: "progress",
        processed: state.processedChats,
        total: state.totalChats,
        status: `Staged chat ${state.processedChats}/${state.totalChats}`,
        processedMedia: state.processedMedia,
        bytesWritten: state.totalSizeBytes,
        currentBatch: state.currentBatchNumber,
        totalBatches: state.totalBatches,
      } as BulkExportWorkerResponse);

      // Yield to event loop every 5 chats to prevent blocking
      if (i % 5 === 0) {
        await yieldToEventLoop();
      }
    } catch (err) {
      log.error(`[BulkExportWorker] Failed to export chat ${chatId}:`, err);
      batchSkippedCount++;
      // Continue with other chats in the batch
    }
    batchConsumedCount++;
  }

  log.info(
    `[BulkExportWorker] Batch ${batchNumber}/${totalBatches} complete: ${batchProcessedCount} processed, ${batchSkippedCount} skipped`,
  );

  return {
    processedCount: batchProcessedCount,
    skippedCount: batchSkippedCount,
    unmovedCount: batchUnmovedCount,
    consumedCount: batchConsumedCount,
    nextAttachmentIndex: attachmentIndex,
  };
}

/**
 * Process the next batch
 *
 * Everything this posts carries the requestId of the job's start, which is the listener the
 * service worker holds for it. A resume (or a processNextBatch message) arrives with none of its
 * own, so the message's requestId is not used.
 *
 * The job is over once workerState is no longer `state`: a cancel nulls it, and a start accepted
 * after that replaces it. Every await below can end the job, so each is followed by that check
 * before anything touches the state or posts.
 */
async function processNextBatch(): Promise<void> {
  const state = workerState;
  if (!state) {
    return;
  }
  const requestId = state.requestId;
  const isCurrent = () => workerState === state;

  // Check status
  if (state.status === "cancelled") {
    self.postMessage({
      type: "cancelled",
      requestId,
    } as BulkExportWorkerResponse);
    cleanupPendingRequests("Export operation cancelled");
    return;
  }

  if (state.status === "paused") {
    self.postMessage({
      type: "paused",
      requestId,
    } as BulkExportWorkerResponse);
    return;
  }

  if (state.remainingChatIds.length === 0) {
    // All batches complete
    self.postMessage({
      type: "complete",
      processed: state.processedChats,
      skipped: state.skippedCount,
      unmoved: state.unmovedCount,
      batches: state.currentBatchNumber,
      requestId,
    } as BulkExportWorkerResponse);
    cleanupPendingRequests("Export operation completed");
    workerState = null;
    return;
  }

  // Take the next batch. Batches are fixed windows of BATCH_SIZE over the original list, so a
  // batch that a pause cut short is finished first: what is left of its window is the next batch.
  const done = state.totalChats - state.remainingChatIds.length;
  const batchChatIds = state.remainingChatIds.slice(0, BATCH_SIZE - (done % BATCH_SIZE));
  const batchNumber = state.currentBatchNumber + 1;

  // Send progress update
  self.postMessage({
    type: "progress",
    processed: state.processedChats,
    total: state.totalChats,
    status: `Processing batch ${batchNumber}/${state.totalBatches}...`,
    processedMedia: state.processedMedia,
    bytesWritten: state.totalSizeBytes,
    currentBatch: batchNumber,
    totalBatches: state.totalBatches,
    requestId,
  } as BulkExportWorkerResponse);

  try {
    // Process the batch
    const result = await processBatch(
      batchChatIds,
      batchNumber,
      state.totalBatches,
      state.options,
      state.globalAttachmentIndex,
      state,
    );

    if (!isCurrent()) {
      return;
    }

    // Update state. Only the chats the batch dealt with leave the queue: a pause that lands
    // mid-batch stops it early, and the rest must still be there when the export resumes.
    state.skippedCount += result.skippedCount;
    state.unmovedCount += result.unmovedCount;
    state.remainingChatIds = state.remainingChatIds.slice(result.consumedCount);
    state.globalAttachmentIndex = result.nextAttachmentIndex;

    if (result.consumedCount < batchChatIds.length) {
      // The batch is not finished: no batch-complete, and the next call reports the pause.
      await processNextBatch();
      return;
    }
    state.currentBatchNumber = batchNumber;

    // Send batch complete message (staging-only)
    self.postMessage({
      type: "batchComplete",
      batchNumber,
      zipFilename: `staging_batch_${batchNumber}`,
      requestId,
    } as BulkExportWorkerResponse);

    // Send progress update after batch completion
    self.postMessage({
      type: "progress",
      processed: state.processedChats,
      total: state.totalChats,
      status: `Completed batch ${batchNumber}/${state.totalBatches}. ${state.remainingChatIds.length} chats remaining.`,
      processedMedia: state.processedMedia,
      bytesWritten: state.totalSizeBytes,
      currentBatch: batchNumber,
      totalBatches: state.totalBatches,
      requestId,
    } as BulkExportWorkerResponse);

    // Continue with next batch if there are more
    if (state.remainingChatIds.length > 0) {
      // Small delay before next batch
      await yieldToEventLoop();
      if (!isCurrent()) {
        return;
      }
      await processNextBatch();
    } else {
      self.postMessage({
        type: "progress",
        processed: state.processedChats,
        total: state.totalChats,
        status: BULK_EXPORT_MANIFEST_STATUS,
        processedMedia: state.processedMedia,
        bytesWritten: state.totalSizeBytes,
        currentBatch: batchNumber,
        totalBatches: state.totalBatches,
        requestId,
      } as BulkExportWorkerResponse);
      await state.manifestWriter.writeMeta({
        haevn_version: state.meta.haevnVersion,
        export_version: state.meta.exportVersion,
        export_id: state.exportId,
        export_timestamp: state.meta.exportTimestamp,
        total_chats: state.totalChats,
        total_media_items: state.totalMediaItems,
        total_size_bytes: state.totalSizeBytes,
        provider_stats: state.providerStats,
      });
      if (!isCurrent()) {
        return;
      }
      await buildManifestJson(state);
      if (!isCurrent()) {
        return;
      }
      self.postMessage({
        type: "progress",
        processed: state.processedChats,
        total: state.totalChats,
        status: BULK_EXPORT_ZIP_STATUS,
        processedMedia: state.processedMedia,
        bytesWritten: state.totalSizeBytes,
        currentBatch: batchNumber,
        totalBatches: state.totalBatches,
        requestId,
      } as BulkExportWorkerResponse);
      log.info("[BulkExportWorker] Starting buildZipFromStaging...");
      await withTimeout(buildZipFromStaging(state), ZIP_BUILD_TIMEOUT_MS, "buildZipFromStaging");
      if (!isCurrent()) {
        return;
      }
      log.info("[BulkExportWorker] buildZipFromStaging completed, sending complete message");
      // All done
      self.postMessage({
        type: "complete",
        processed: state.processedChats,
        skipped: state.skippedCount,
        unmoved: state.unmovedCount,
        batches: batchNumber,
        requestId,
      } as BulkExportWorkerResponse);
      log.info("[BulkExportWorker] Complete message sent");
      cleanupPendingRequests("Export operation completed");
      workerState = null;
    }
  } catch (error) {
    if (!isCurrent()) {
      // The job was cancelled, and what it was doing failed on the way out: nothing to report.
      log.warn("[BulkExportWorker] A cancelled export's batch failed:", error);
      return;
    }
    log.error("[BulkExportWorker] Error processing batch:", error);
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      requestId,
    } as BulkExportWorkerResponse);
    cleanupPendingRequests("Export operation failed");
    workerState = null;
  }
}

// Message handler
// CRD-003: Handles both commands from service worker and responses from browser API bridge
self.onmessage = async (event: MessageEvent<BulkExportWorkerMessage>) => {
  const msg = event.data;
  const requestId = msg.requestId;

  try {
    // Handle responses from service worker (CRD-003 pattern)
    if (msg.type === "downloadComplete") {
      const pending = pendingDownloadRequests.get(msg.requestId);
      if (!pending) {
        log.warn(
          `[BulkExportWorker] Received download response for unknown requestId: ${msg.requestId}`,
        );
        return;
      }

      clearTimeout(pending.timeout);
      pendingDownloadRequests.delete(msg.requestId);

      if (msg.success) {
        log.info(
          `[BulkExportWorker] Download completed successfully, requestId: ${msg.requestId}, downloadId: ${msg.downloadId}`,
        );
        pending.resolve({ downloadId: msg.downloadId });
      } else {
        log.error(
          `[BulkExportWorker] Download failed, requestId: ${msg.requestId}, error: ${msg.error}`,
        );
        pending.reject(new Error(msg.error || "Download failed"));
      }
      return; // Response handled, don't process as command
    }

    if (msg.type === "browserApiResponse") {
      // Generic browser API response handler (CRD-003)
      const pending = pendingDownloadRequests.get(msg.requestId);
      if (!pending) {
        log.warn(
          `[BulkExportWorker] Received browser API response for unknown requestId: ${msg.requestId}`,
        );
        return;
      }

      clearTimeout(pending.timeout);
      pendingDownloadRequests.delete(msg.requestId);

      if (msg.success) {
        log.info(`[BulkExportWorker] Browser API request completed, requestId: ${msg.requestId}`);
        pending.resolve(msg.result);
      } else {
        log.error(
          `[BulkExportWorker] Browser API request failed, requestId: ${msg.requestId}, error: ${msg.error}`,
        );
        pending.reject(new Error(msg.error || "Browser API request failed"));
      }
      return; // Response handled, don't process as command
    }

    // Handle commands from service worker
    switch (msg.type) {
      case "start": {
        // HVN-55: a job that is running or paused owns workerState. A second start would
        // overwrite it and create its staging, so refuse it and leave both alone.
        if (workerState && (workerState.status === "running" || workerState.status === "paused")) {
          self.postMessage({
            type: "error",
            error: "An export is already running in the worker.",
            requestId,
          } as BulkExportWorkerResponse);
          break;
        }

        // Split chatIds into batches
        const batches: string[][] = [];
        for (let i = 0; i < msg.chatIds.length; i += BATCH_SIZE) {
          batches.push(msg.chatIds.slice(i, i + BATCH_SIZE));
        }

        const totalBatches = batches.length;
        log.info(
          `[BulkExportWorker] Starting export: ${msg.chatIds.length} chats split into ${totalBatches} batch(es)`,
        );

        const manifestWriter = new ExportManifestWriter(msg.exportId);

        // The job owns workerState from here, before the staging setup is awaited: a cancel (or
        // a pause) that lands during the setup finds it and acts on it, and a second start is
        // refused by the guard above instead of racing the setup (HVN-63).
        const state: WorkerState = {
          status: "running",
          requestId,
          remainingChatIds: msg.chatIds,
          options: msg.options,
          currentBatchNumber: 0,
          totalBatches,
          totalChats: msg.chatIds.length,
          processedChats: 0,
          skippedCount: 0,
          unmovedCount: 0,
          globalAttachmentIndex: 0,
          exportId: msg.exportId,
          meta: msg.meta,
          manifestWriter,
          providerStats: {},
          totalMediaItems: 0,
          totalSizeBytes: 0,
          processedMedia: 0,
        };
        workerState = state;

        try {
          await ensureExportStagingDirectories(msg.exportId);
        } catch (error) {
          // A setup that failed has no job: free the guard, then report it as any start's failure.
          if (workerState === state) {
            workerState = null;
          }
          throw error;
        }
        if (workerState !== state) {
          // Cancelled during the setup: the cancel has answered, and the job never begins.
          break;
        }

        // Start processing
        await processNextBatch();
        break;
      }

      case "pause": {
        if (workerState) {
          workerState.status = "paused";
          self.postMessage({
            type: "paused",
            requestId,
          } as BulkExportWorkerResponse);
        }
        break;
      }

      case "resume": {
        if (workerState && workerState.status === "paused") {
          workerState.status = "running";
          await processNextBatch();
        }
        break;
      }

      case "cancel": {
        if (workerState) {
          workerState.status = "cancelled";
          // The service worker's cancel has no requestId of its own, and `cancelled` is how the
          // start's listener learns the job is over, so it answers on the start's.
          self.postMessage({
            type: "cancelled",
            requestId: workerState.requestId,
          } as BulkExportWorkerResponse);
          cleanupPendingRequests("Export operation cancelled");
          workerState = null;
        }
        break;
      }

      case "processNextBatch": {
        await processNextBatch();
        break;
      }

      default: {
        const exhaustiveCheck: never = msg;
        log.error("[BulkExportWorker] Unknown message type:", exhaustiveCheck);
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${exhaustiveCheck}`,
          requestId,
        } as BulkExportWorkerResponse);
      }
    }
  } catch (error) {
    log.error("[BulkExportWorker] Error handling message:", error);
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : "Unknown error occurred",
      requestId,
    } as BulkExportWorkerResponse);
  }
};
