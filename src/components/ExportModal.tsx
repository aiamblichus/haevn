import React, { useEffect, useState } from "react";
import type { ExportOptions } from "../formatters";
import type { BackgroundEvent } from "../types/messaging";
import { log } from "../utils/logger";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Progress } from "./ui/progress";

interface ExportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exportModalIds: string[] | null;
  exportOptions: ExportOptions;
  onClose: () => void;
  onStatus?: (text: string, kind?: "ok" | "warn" | "error" | "work") => void;
  onExportChatById?: (chatId: string, options: ExportOptions) => Promise<void>;
}

interface ExportProgress {
  processed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  status: string;
  downloadedFiles: string[];
  isPaused: boolean;
  isComplete: boolean;
}

export const ExportModal = ({
  open,
  onOpenChange,
  exportModalIds,
  exportOptions,
  onClose,
  onStatus,
  onExportChatById,
}: ExportModalProps) => {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);

  // Status helper that falls back to logging
  const setStatus = (text: string, kind: "ok" | "warn" | "error" | "work" = "ok") => {
    if (onStatus) {
      onStatus(text, kind);
    } else {
      if (kind === "error") log.error(`[ExportModal] ${text}`);
      else if (kind === "warn") log.warn(`[ExportModal] ${text}`);
      else log.info(`[ExportModal] ${text}`);
    }
  };

  // Internal export handler if none provided
  const internalExportChatById = async (chatId: string, options: ExportOptions) => {
    if (onExportChatById) {
      await onExportChatById(chatId, options);
    } else {
      await chrome.runtime.sendMessage({
        action: "exportSyncedChat",
        chatId,
        options,
      });
      setStatus("Export triggered.", "ok");
    }
  };

  // Listen for bulk export messages
  useEffect(() => {
    if (!open || !isExporting) return;

    const messageListener = (message: unknown) => {
      if (typeof message !== "object" || message === null || !("action" in message)) {
        return;
      }
      const msg = message as BackgroundEvent & {
        action?: string;
        totalChats?: number;
        totalBatches?: number;
        downloadedFiles?: string[];
        processed?: number;
        total?: number;
        currentBatch?: number;
        status?: string;
        message?: string;
      };
      switch (msg.action) {
        case "bulkExportStarted":
          if ("totalChats" in msg && "totalBatches" in msg) {
            setProgress({
              processed: 0,
              total: msg.totalChats || 0,
              currentBatch: 0,
              totalBatches: msg.totalBatches || 0,
              status: "Starting export...",
              downloadedFiles: msg.downloadedFiles || [],
              isPaused: false,
              isComplete: false,
            });
          }
          break;
        case "bulkExportProgress":
          if ("processed" in msg && "total" in msg) {
            setProgress({
              processed: msg.processed || 0,
              total: msg.total || 0,
              currentBatch: msg.currentBatch || 0,
              totalBatches: msg.totalBatches || 0,
              status: msg.status || "Processing...",
              downloadedFiles: msg.downloadedFiles || [],
              isPaused: false,
              isComplete: false,
            });
          }
          break;
        case "bulkExportPaused":
          if (progress) {
            setProgress({ ...progress, isPaused: true });
          }
          break;
        case "bulkExportResumed":
          if (progress) {
            setProgress({ ...progress, isPaused: false });
          }
          break;
        case "bulkExportComplete":
          setProgress((prev) =>
            prev
              ? {
                  ...prev,
                  processed: prev.total,
                  status: "message" in msg ? msg.message || "Export complete!" : "Export complete!",
                  isPaused: false,
                  isComplete: true,
                }
              : null,
          );
          // Keep modal open to show completion state
          break;
        case "bulkExportCanceled":
        case "bulkExportFailed":
          setIsExporting(false);
          setProgress(null);
          break;
      }
    };

    chrome.runtime.onMessage.addListener(messageListener);
    return () => chrome.runtime.onMessage.removeListener(messageListener);
  }, [open, isExporting, progress]);

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setIsExporting(false);
      setProgress(null);
    }
  }, [open]);

  const handleStartExport = async () => {
    if (exportModalIds && exportModalIds.length === 1) {
      // Single chat export
      await internalExportChatById(exportModalIds[0], exportOptions);
      onClose();
    } else if (exportModalIds && exportModalIds.length > 1) {
      // Bulk export
      setIsExporting(true);
      try {
        const resp = await chrome.runtime.sendMessage({
          action: "startBulkExport",
          chatIds: exportModalIds,
          options: exportOptions,
        });
        if (!resp?.success) {
          setStatus(`Export failed to start: ${resp?.error || "Unknown error"}`, "error");
          setIsExporting(false);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus(`Export failed: ${msg}`, "error");
        setIsExporting(false);
      }
    }
  };

  const handlePause = async () => {
    try {
      await chrome.runtime.sendMessage({ action: "pauseBulkExport" });
    } catch (e) {
      log.error("Failed to pause export:", e);
    }
  };

  const handleResume = async () => {
    try {
      await chrome.runtime.sendMessage({ action: "resumeBulkExport" });
    } catch (e) {
      log.error("Failed to resume export:", e);
    }
  };

  const handleCancel = async () => {
    try {
      await chrome.runtime.sendMessage({ action: "cancelBulkExport" });
    } catch (e) {
      log.error("Failed to cancel export:", e);
    }
    setIsExporting(false);
    setProgress(null);
    onClose();
  };

  const progressPercent =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {exportModalIds && (
        <DialogContent className="max-w-2xl">
          {!isExporting ? (
            // Options View
            <>
              <DialogHeader>
                <DialogTitle>Export</DialogTitle>
                <DialogDescription>
                  {exportModalIds.length} chat(s) will be exported.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button onClick={handleStartExport}>Export</Button>
              </DialogFooter>
            </>
          ) : (
            // Progress View
            <>
              <DialogHeader>
                <DialogTitle>Exporting Chats</DialogTitle>
                <DialogDescription>
                  {progress
                    ? `Exporting batch ${progress.currentBatch} of ${progress.totalBatches}...`
                    : "Preparing export..."}
                </DialogDescription>
              </DialogHeader>
              <div className="mt-4 space-y-4">
                {/* Overall Status */}
                <div>
                  <div className="text-sm font-medium text-slate-700 mb-2">
                    {progress?.status || "Starting export..."}
                  </div>
                  {progress && (
                    <div className="text-xs text-muted-foreground mb-2">
                      {progress.processed} of {progress.total} chats processed
                      {progress.isPaused && " (Paused)"}
                    </div>
                  )}
                </div>

                {/* Progress Bar */}
                {progress && (
                  <div className="space-y-2">
                    <Progress value={progressPercent} className="h-2" />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{progressPercent}%</span>
                      <span>
                        Batch {progress.currentBatch} / {progress.totalBatches}
                      </span>
                    </div>
                  </div>
                )}

                {/* Downloaded Files Log */}
                {progress && progress.downloadedFiles.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-sm font-medium text-slate-700">
                      Downloaded Files ({progress.downloadedFiles.length})
                    </div>
                    <div className="max-h-48 overflow-y-auto border rounded-md p-2 bg-slate-50 dark:bg-slate-900">
                      <ul className="space-y-1 text-xs font-mono">
                        {progress.downloadedFiles.map((filename) => (
                          <li key={filename} className="text-muted-foreground">
                            ✓ {filename}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </div>
              <DialogFooter>
                {progress?.isComplete ? (
                  <Button onClick={onClose}>Close</Button>
                ) : progress?.isPaused ? (
                  <Button onClick={handleResume}>Resume</Button>
                ) : (
                  <>
                    <Button variant="outline" onClick={handlePause}>
                      Pause
                    </Button>
                    <Button variant="destructive" onClick={handleCancel}>
                      Cancel
                    </Button>
                  </>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      )}
    </Dialog>
  );
};
