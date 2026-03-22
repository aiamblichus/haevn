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
  globalAttachmentIndex: number; // For unique attachment names across batches
}
