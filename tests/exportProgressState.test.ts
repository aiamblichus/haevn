import { describe, expect, it } from "vitest";
import {
  dismissNeedsConfirm,
  type ExportProgress,
  exportFooter,
  exportProgressHeading,
} from "../src/components/exportProgressState";
import { BULK_EXPORT_MANIFEST_STATUS, BULK_EXPORT_ZIP_STATUS } from "../src/types/workerMessages";

function progress(overrides: Partial<ExportProgress> = {}): ExportProgress {
  return {
    processed: 40,
    total: 120,
    currentBatch: 2,
    totalBatches: 4,
    status: "Batch 2 of 4",
    downloadedFiles: [],
    isPaused: false,
    isComplete: false,
    ...overrides,
  };
}

describe("exportFooter", () => {
  it("offers Pause and Cancel while the export runs", () => {
    expect(exportFooter(progress())).toEqual({
      close: false,
      resume: false,
      pause: true,
      pauseDisabled: false,
      cancel: true,
    });
  });

  it("offers Resume and Cancel while the export is paused, and no Pause", () => {
    expect(exportFooter(progress({ isPaused: true }))).toEqual({
      close: false,
      resume: true,
      pause: false,
      pauseDisabled: false,
      cancel: true,
    });
  });

  it("disables Pause while the worker builds the ZIP, and keeps Cancel", () => {
    expect(exportFooter(progress({ status: BULK_EXPORT_ZIP_STATUS }))).toEqual({
      close: false,
      resume: false,
      pause: true,
      pauseDisabled: true,
      cancel: true,
    });
  });

  it("disables Pause while the worker finalizes the manifest", () => {
    expect(exportFooter(progress({ status: BULK_EXPORT_MANIFEST_STATUS })).pauseDisabled).toBe(
      true,
    );
  });

  it("offers only Close once the export is finished", () => {
    expect(exportFooter(progress({ isComplete: true, processed: 120 }))).toEqual({
      close: true,
      resume: false,
      pause: false,
      pauseDisabled: false,
      cancel: false,
    });
  });

  it("offers Pause and Cancel before the first progress event", () => {
    expect(exportFooter(null)).toEqual({
      close: false,
      resume: false,
      pause: true,
      pauseDisabled: false,
      cancel: true,
    });
  });
});

describe("dismissNeedsConfirm", () => {
  it("asks while a running export is dismissed", () => {
    expect(dismissNeedsConfirm(true, progress())).toBe(true);
  });

  it("asks while a paused export is dismissed", () => {
    expect(dismissNeedsConfirm(true, progress({ isPaused: true }))).toBe(true);
  });

  it("asks while the export is still preparing", () => {
    expect(dismissNeedsConfirm(true, null)).toBe(true);
  });

  it("does not ask once the export is finished", () => {
    expect(dismissNeedsConfirm(true, progress({ isComplete: true }))).toBe(false);
  });

  it("does not ask when no export is running", () => {
    expect(dismissNeedsConfirm(false, null)).toBe(false);
    expect(dismissNeedsConfirm(false, progress())).toBe(false);
  });
});

describe("exportProgressHeading", () => {
  it("says the export is finished, not that it is exporting a batch", () => {
    const heading = exportProgressHeading(
      progress({ isComplete: true, processed: 120, currentBatch: 4, totalBatches: 4 }),
    );
    expect(heading).toEqual({ title: "Export finished", description: "120 chat(s) exported." });
  });

  it("names the batch while the export runs", () => {
    expect(exportProgressHeading(progress())).toEqual({
      title: "Exporting Chats",
      description: "Exporting batch 2 of 4...",
    });
  });

  it("says it is preparing before the first progress event", () => {
    expect(exportProgressHeading(null)).toEqual({
      title: "Exporting Chats",
      description: "Preparing export...",
    });
  });
});
