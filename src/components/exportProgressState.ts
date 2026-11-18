import { BULK_EXPORT_MANIFEST_STATUS, BULK_EXPORT_ZIP_STATUS } from "../types/workerMessages";

/** The phases after the last batch: the worker no longer checks for a pause in them. */
const UNPAUSABLE = new Set<string>([BULK_EXPORT_MANIFEST_STATUS, BULK_EXPORT_ZIP_STATUS]);

/** The bulk export events folded into the shape the progress view shows. */
export interface ExportProgress {
  processed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
  status: string;
  downloadedFiles: string[];
  isPaused: boolean;
  isComplete: boolean;
}

export interface ExportFooter {
  close: boolean;
  resume: boolean;
  pause: boolean;
  pauseDisabled: boolean;
  cancel: boolean;
}

/**
 * Which buttons the progress view shows. A finished export offers only Close. A paused one offers
 * Resume and Cancel. A running one offers Pause and Cancel; Pause is shown but disabled while the
 * worker finalizes the manifest or builds the ZIP, because those phases have no point where a
 * pause takes effect.
 */
export function exportFooter(progress: ExportProgress | null): ExportFooter {
  if (progress?.isComplete) {
    return { close: true, resume: false, pause: false, pauseDisabled: false, cancel: false };
  }
  if (progress?.isPaused) {
    return { close: false, resume: true, pause: false, pauseDisabled: false, cancel: true };
  }
  return {
    close: false,
    resume: false,
    pause: true,
    pauseDisabled: progress !== null && UNPAUSABLE.has(progress.status),
    cancel: true,
  };
}

/**
 * Whether a dismissal (the X, Escape, a click outside) must ask before it closes. While an export
 * runs or is paused, closing the dialog would leave the export going with nothing to show it, so
 * the dialog asks first, and only a confirmed cancel ends the export.
 */
export function dismissNeedsConfirm(
  isExporting: boolean,
  progress: ExportProgress | null,
): boolean {
  return isExporting && !progress?.isComplete;
}

/** The title and the line under it of the progress view. */
export function exportProgressHeading(progress: ExportProgress | null): {
  title: string;
  description: string;
} {
  if (progress?.isComplete) {
    return {
      title: "Export finished",
      description: `${progress.total} chat(s) exported.`,
    };
  }
  return {
    title: "Exporting Chats",
    description: progress
      ? `Exporting batch ${progress.currentBatch} of ${progress.totalBatches}...`
      : "Preparing export...",
  };
}
