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
import { HaevnDatabase } from "../../services/db";
import { ExportManifestWriter } from "../../services/exportManifest";
import {
  buildExportChatsPath,
  buildExportMediaPath,
  buildExportStagingRoot,
  buildExportZipPath,
  ensureExportStagingDirectories,
} from "../../services/exportStaging";
import type { BulkExportWorkerMessage, BulkExportWorkerResponse } from "../../types/workerMessages";
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
  remainingChatIds: string[];
  options: ExportOptions;
  currentBatchNumber: number;
  totalBatches: number;
  totalChats: number;
  processedChats: number;
  skippedCount: number;
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
  const chatJson = JSON.stringify(chat);
  const chatPath = buildExportChatsPath(state.exportId, chatId);
  const chatBytes = textEncoder.encode(chatJson);
  await writeFile(chatPath, chatBytes);
  state.totalSizeBytes += chatBytes.byteLength;

  await state.manifestWriter.appendChat({
    id: chat.id,
    source: chat.source,
    sourceId: chat.sourceId,
    file: `chats/${chat.id}.json`,
  });

  state.providerStats[chat.source] = (state.providerStats[chat.source] || 0) + 1;

  const attachments = extractAttachmentsFromChat(chat, options.messageIds);
  for (const attachment of attachments) {
    if (state.status !== "running") {
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

async function loadChatWithMessages(chatId: string): Promise<Chat | undefined> {
  const chat = await db.chats.get(chatId);
  if (!chat) return undefined;

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

  return {
    ...chat,
    ...(rows.length > 0 ? { messages: toMessageDict(rows) } : {}),
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
  nextAttachmentIndex: number;
}> {
  log.info(
    `[BulkExportWorker] Processing batch ${batchNumber}/${totalBatches} (${batchChatIds.length} chats)...`,
  );

  let batchProcessedCount = 0;
  let batchSkippedCount = 0;
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
  }

  log.info(
    `[BulkExportWorker] Batch ${batchNumber}/${totalBatches} complete: ${batchProcessedCount} processed, ${batchSkippedCount} skipped`,
  );

  return {
    processedCount: batchProcessedCount,
    skippedCount: batchSkippedCount,
    nextAttachmentIndex: attachmentIndex,
  };
}

/**
 * Process the next batch
 */
async function processNextBatch(requestId?: string): Promise<void> {
  if (!workerState) {
    return;
  }

  // Check status
  if (workerState.status === "cancelled") {
    self.postMessage({
      type: "cancelled",
      requestId,
    } as BulkExportWorkerResponse);
    cleanupPendingRequests("Export operation cancelled");
    return;
  }

  if (workerState.status === "paused") {
    self.postMessage({
      type: "paused",
      requestId,
    } as BulkExportWorkerResponse);
    return;
  }

  if (workerState.remainingChatIds.length === 0) {
    // All batches complete
    self.postMessage({
      type: "complete",
      processed: workerState.processedChats,
      skipped: workerState.skippedCount,
      batches: workerState.currentBatchNumber,
      requestId,
    } as BulkExportWorkerResponse);
    cleanupPendingRequests("Export operation completed");
    workerState = null;
    return;
  }

  // Take the next batch
  const batchChatIds = workerState.remainingChatIds.slice(0, BATCH_SIZE);
  const batchNumber = workerState.currentBatchNumber + 1;

  // Send progress update
  self.postMessage({
    type: "progress",
    processed: workerState.processedChats,
    total: workerState.totalChats,
    status: `Processing batch ${batchNumber}/${workerState.totalBatches}...`,
    processedMedia: workerState.processedMedia,
    bytesWritten: workerState.totalSizeBytes,
    currentBatch: batchNumber,
    totalBatches: workerState.totalBatches,
    requestId,
  } as BulkExportWorkerResponse);

  try {
    // Process the batch
    const result = await processBatch(
      batchChatIds,
      batchNumber,
      workerState.totalBatches,
      workerState.options,
      workerState.globalAttachmentIndex,
      workerState,
    );

    // Update state
    workerState.currentBatchNumber = batchNumber;
    workerState.skippedCount += result.skippedCount;
    workerState.remainingChatIds = workerState.remainingChatIds.slice(BATCH_SIZE);
    workerState.globalAttachmentIndex = result.nextAttachmentIndex;

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
      processed: workerState.processedChats,
      total: workerState.totalChats,
      status: `Completed batch ${batchNumber}/${workerState.totalBatches}. ${workerState.remainingChatIds.length} chats remaining.`,
      processedMedia: workerState.processedMedia,
      bytesWritten: workerState.totalSizeBytes,
      currentBatch: batchNumber,
      totalBatches: workerState.totalBatches,
      requestId,
    } as BulkExportWorkerResponse);

    // Continue with next batch if there are more
    if (workerState.remainingChatIds.length > 0) {
      // Small delay before next batch
      await yieldToEventLoop();
      await processNextBatch(requestId);
    } else {
      self.postMessage({
        type: "progress",
        processed: workerState.processedChats,
        total: workerState.totalChats,
        status: "Finalizing manifest...",
        processedMedia: workerState.processedMedia,
        bytesWritten: workerState.totalSizeBytes,
        currentBatch: batchNumber,
        totalBatches: workerState.totalBatches,
        requestId,
      } as BulkExportWorkerResponse);
      await workerState.manifestWriter.writeMeta({
        haevn_version: workerState.meta.haevnVersion,
        export_version: workerState.meta.exportVersion,
        export_id: workerState.exportId,
        export_timestamp: workerState.meta.exportTimestamp,
        total_chats: workerState.totalChats,
        total_media_items: workerState.totalMediaItems,
        total_size_bytes: workerState.totalSizeBytes,
        provider_stats: workerState.providerStats,
      });
      await buildManifestJson(workerState);
      self.postMessage({
        type: "progress",
        processed: workerState.processedChats,
        total: workerState.totalChats,
        status: "Building ZIP archive...",
        processedMedia: workerState.processedMedia,
        bytesWritten: workerState.totalSizeBytes,
        currentBatch: batchNumber,
        totalBatches: workerState.totalBatches,
        requestId,
      } as BulkExportWorkerResponse);
      log.info("[BulkExportWorker] Starting buildZipFromStaging...");
      await withTimeout(
        buildZipFromStaging(workerState),
        ZIP_BUILD_TIMEOUT_MS,
        "buildZipFromStaging",
      );
      log.info("[BulkExportWorker] buildZipFromStaging completed, sending complete message");
      // All done
      self.postMessage({
        type: "complete",
        processed: workerState.processedChats,
        skipped: workerState.skippedCount,
        batches: batchNumber,
        requestId,
      } as BulkExportWorkerResponse);
      log.info("[BulkExportWorker] Complete message sent");
      cleanupPendingRequests("Export operation completed");
      workerState = null;
    }
  } catch (error) {
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
        // Split chatIds into batches
        const batches: string[][] = [];
        for (let i = 0; i < msg.chatIds.length; i += BATCH_SIZE) {
          batches.push(msg.chatIds.slice(i, i + BATCH_SIZE));
        }

        const totalBatches = batches.length;
        log.info(
          `[BulkExportWorker] Starting export: ${msg.chatIds.length} chats split into ${totalBatches} batch(es)`,
        );

        await ensureExportStagingDirectories(msg.exportId);
        const manifestWriter = new ExportManifestWriter(msg.exportId);

        // Initialize state
        workerState = {
          status: "running",
          remainingChatIds: msg.chatIds,
          options: msg.options,
          currentBatchNumber: 0,
          totalBatches,
          totalChats: msg.chatIds.length,
          processedChats: 0,
          skippedCount: 0,
          globalAttachmentIndex: 0,
          exportId: msg.exportId,
          meta: msg.meta,
          manifestWriter,
          providerStats: {},
          totalMediaItems: 0,
          totalSizeBytes: 0,
          processedMedia: 0,
        };

        // Start processing
        await processNextBatch(requestId);
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
          await processNextBatch(requestId);
        }
        break;
      }

      case "cancel": {
        if (workerState) {
          workerState.status = "cancelled";
          self.postMessage({
            type: "cancelled",
            requestId,
          } as BulkExportWorkerResponse);
          cleanupPendingRequests("Export operation cancelled");
          workerState = null;
        }
        break;
      }

      case "processNextBatch": {
        await processNextBatch(requestId);
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
