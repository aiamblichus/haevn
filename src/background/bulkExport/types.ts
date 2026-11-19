// Types for bulk export operations

import type { ExportOptions } from "../../formatters";

export interface BulkExportState {
  status: "running" | "paused" | "complete" | "error";
  totalChats: number;
  processedChats: number;
  remainingChatIds: string[];
  options: ExportOptions;
  currentBatchNumber: number;
  totalBatches: number;
  downloadedFiles: string[];
  skippedCount: number;
  /** Of the skipped, the chats whose messages had not moved to the table yet (HVN-31). */
  unmovedCount: number;
  globalAttachmentIndex: number; // For unique attachment names across batches
}
