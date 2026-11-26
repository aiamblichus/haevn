import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Progress } from "../../../components/ui/progress";
import { cn } from "../../../lib/utils";
import type { BackgroundEvent } from "../../../types/messaging";
import { fireAndForget } from "../../../utils/error_utils";
import { log } from "../../../utils/logger";
import { fileNameShape } from "../../../utils/logShape";
import { buildImportStagingPath, deleteFileFromOpfs, writeFileToOpfs } from "../../../utils/opfs";
import { useStatus } from "../../context/StatusContext";
import { handleImport } from "../../import/importHandlers";
import { useWindowDropGuard } from "../../import/windowDropGuard";
import { FragmentImportPanel } from "./FragmentImportPanel";
import { formatListedUnder } from "./importFormats";

type ImportProviderType =
  | "chatgpt_zip"
  | "claude_zip"
  | "codex_jsonl"
  | "pi_jsonl"
  | "openrouter_json"
  | "openwebui_json"
  | "openwebui_zip"
  | "haevn_export_zip"
  | "haevn_markdown"
  | "claudecode_jsonl"
  | "fragment_md";

interface ImportProgress {
  total: number;
  processed: number;
  saved: number;
  skipped: number;
  errors: number;
  phase?: "counting" | "manifest" | "chats" | "media" | "index";
  processedMedia?: number;
  totalMedia?: number;
  bytesWritten?: number;
  totalBytes?: number;
}

/** The drop zone of the formats that take one file: the archive's tokens, no fixed colours */
const dropZoneClass = (active: boolean) =>
  cn(
    "border-2 border-dashed rounded-md p-4 text-center text-xs",
    active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground",
  );

const FILE_INPUT_CLASS =
  "text-xs text-muted-foreground file:mr-3 file:cursor-pointer file:border-2 file:border-border file:bg-card file:px-3 file:py-1.5 file:text-xs file:font-bold file:uppercase file:tracking-wider file:text-foreground hover:file:border-primary";

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  importProviderFilter: string | null;
  onLoadChats: () => void | Promise<void>;
  /** Closes the dialog and shows the archive filtered to fragments (HVN-163) */
  onShowFragments: () => void;
  /** Where focus goes when the dialog closes: the page decides (the opener, or the Provider filter) */
  onCloseAutoFocus: (event: Event) => void;
}

export const ImportModal = ({
  open,
  onOpenChange,
  importProviderFilter,
  onLoadChats,
  onShowFragments,
  onCloseAutoFocus,
}: ImportModalProps) => {
  const { setStatus } = useStatus();
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importProvider, setImportProvider] = useState<ImportProviderType>("chatgpt_zip");

  // Update importProvider when importProviderFilter changes or modal opens
  useEffect(() => {
    if (open) {
      // Clear error state when modal opens
      setImportError(null);
      if (importProviderFilter) {
        // If a filter is set, use it as the default provider type
        // Validate that it's a valid ImportProviderType
        const validTypes: ImportProviderType[] = [
          "chatgpt_zip",
          "claude_zip",
          "codex_jsonl",
          "pi_jsonl",
          "openrouter_json",
          "openwebui_json",
          "openwebui_zip",
          "haevn_export_zip",
          "haevn_markdown",
          "claudecode_jsonl",
          "fragment_md",
        ];
        if (validTypes.includes(importProviderFilter as ImportProviderType)) {
          setImportProvider(importProviderFilter as ImportProviderType);
        }
      } else {
        // If no filter is set, default to chatgpt_zip
        setImportProvider("chatgpt_zip");
      }
    }
  }, [open, importProviderFilter]);
  const [importOverwrite, setImportOverwrite] = useState(true);
  const [importProgress, setImportProgress] = useState<ImportProgress>({
    total: 0,
    processed: 0,
    saved: 0,
    skipped: 0,
    errors: 0,
    phase: undefined,
    processedMedia: 0,
    totalMedia: 0,
    bytesWritten: 0,
    totalBytes: 0,
  });
  const [importRunning, setImportRunning] = useState(false);
  const [isDragActive, setDragActive] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const stagedFilePathRef = useRef<string | null>(null);
  // An import of fragments is running: the dialog is held until it ends
  const [fragmentBusy, setFragmentBusy] = useState(false);
  const isFragment = importProvider === "fragment_md";
  // A file let go beside a drop zone must not open in the tab, whatever the format
  useWindowDropGuard(open);

  const cleanupStagedFile = useCallback(async () => {
    if (!stagedFilePathRef.current) {
      return;
    }
    try {
      await deleteFileFromOpfs(stagedFilePathRef.current);
    } catch (_err: unknown) {
      log.warn(
        "[ImportModal] Failed to delete staged file",
        fileNameShape(stagedFilePathRef.current),
      );
    } finally {
      stagedFilePathRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      fireAndForget(cleanupStagedFile(), "Cleanup staged file on component unmount");
    };
  }, [cleanupStagedFile]);

  // Listen for import progress messages from background
  useEffect(() => {
    const handleMessage = (message: unknown) => {
      if (typeof message === "object" && message !== null && "action" in message) {
        const event = message as BackgroundEvent;
        if (event.action === "importProgress") {
          const progressEvent = event as BackgroundEvent & {
            processed?: number;
            total?: number;
            saved?: number;
            skipped?: number;
            errors?: number;
            status?: string;
            phase?: "counting" | "manifest" | "chats" | "media" | "index";
            processedMedia?: number;
            totalMedia?: number;
            bytesWritten?: number;
            totalBytes?: number;
          };
          setImportProgress({
            total: progressEvent.total || 0,
            processed: progressEvent.processed || 0,
            saved: progressEvent.saved || 0,
            skipped: progressEvent.skipped || 0,
            errors: progressEvent.errors || 0,
            phase: progressEvent.phase,
            processedMedia: progressEvent.processedMedia || 0,
            totalMedia: progressEvent.totalMedia || 0,
            bytesWritten: progressEvent.bytesWritten || 0,
            totalBytes: progressEvent.totalBytes || 0,
          });
          if (progressEvent.status) {
            setStatus(progressEvent.status, "work");
          }
        } else if (event.action === "importComplete") {
          const completeEvent = event as BackgroundEvent & {
            saved?: number;
            skipped?: number;
            errors?: number;
          };
          const { saved, skipped, errors } = completeEvent;
          setStatus(
            `Import complete. Saved ${saved || 0}, skipped ${skipped || 0}, errors ${errors || 0}.`,
            errors ? "warn" : "ok",
          );
          fireAndForget(cleanupStagedFile(), "Cleanup staged file after import completion");
          setImportRunning(false);
          onLoadChats();
        } else if (event.action === "importFailed") {
          const failedEvent = event as BackgroundEvent & {
            error?: string;
          };
          setImportError(failedEvent.error || "Import failed");
          setStatus(`Import failed: ${failedEvent.error}`, "error");
          fireAndForget(cleanupStagedFile(), "Cleanup staged file after import failure");
          setImportRunning(false);
        } else if (event.action === "importCancelled") {
          setStatus("Import cancelled", "warn");
          fireAndForget(cleanupStagedFile(), "Cleanup staged file after import cancellation");
          setImportRunning(false);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [cleanupStagedFile, onLoadChats, setStatus]);

  // Close modal when import completes successfully (no fatal errors)
  useEffect(() => {
    if (
      !importRunning &&
      importProgress.processed > 0 &&
      importProgress.total > 0 &&
      importProgress.processed === importProgress.total &&
      !importError
    ) {
      // Import completed (may have individual item errors, but process finished)
      // Close modal after a brief delay to show completion
      const timer = setTimeout(() => {
        onOpenChange(false);
        // Reset state after closing
        setImportFile(null);
        setImportProgress({
          total: 0,
          processed: 0,
          saved: 0,
          skipped: 0,
          errors: 0,
          phase: undefined,
          processedMedia: 0,
          totalMedia: 0,
          bytesWritten: 0,
          totalBytes: 0,
        });
        setImportError(null);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [importRunning, importProgress, importError, onOpenChange]);

  const handleStartImport = async () => {
    setImportError(null);
    setImportRunning(true);
    try {
      // Import types that use the worker-based background API (offloaded to import.worker.ts)
      const workerImportTypes = [
        "chatgpt_zip",
        "claude_zip",
        "codex_jsonl",
        "pi_jsonl",
        "openrouter_json",
        "openwebui_zip",
        "haevn_export_zip",
        "claudecode_jsonl",
      ];

      if (workerImportTypes.includes(importProvider) && importFile) {
        setStatus("Staging archive in secure storage...", "work");
        await cleanupStagedFile();
        const stagedPath = buildImportStagingPath(importFile.name);
        await writeFileToOpfs(stagedPath, importFile);
        stagedFilePathRef.current = stagedPath;

        // Start import job via background API
        setStatus("Starting import...", "work");
        const resp = await chrome.runtime.sendMessage({
          action: "startImportJob",
          importType: importProvider,
          stagedFilePath: stagedPath,
          originalFileName: importFile.name,
          originalFileType: importFile.type,
          overwriteExisting: importOverwrite,
        });

        if (!resp?.success) {
          throw new Error(resp?.error || "Failed to start import");
        }

        setStatus("Importing archive...", "work");
        // Progress updates will come via message listener (see useEffect below)
      } else {
        // Use existing handler for folder-based and single-file imports
        await handleImport(importProvider, importFile, importOverwrite, {
          setStatus: (text: string, kind?: "ok" | "warn" | "error" | "work") => {
            setStatus(text, kind);
            // Track fatal errors
            if (kind === "error") {
              setImportError(text);
            }
          },
          setImportProgress,
          loadChats: onLoadChats,
        });
        setImportRunning(false);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setImportError(`Import failed: ${msg}`);
      setStatus(`Import failed: ${msg}`, "error");
      fireAndForget(cleanupStagedFile(), "Cleanup staged file on exception");
      setImportRunning(false);
    }
  };

  const handleClose = () => {
    setImportFile(null);
    setImportProgress({
      total: 0,
      processed: 0,
      saved: 0,
      skipped: 0,
      errors: 0,
      phase: undefined,
      processedMedia: 0,
      totalMedia: 0,
      bytesWritten: 0,
      totalBytes: 0,
    });
    setImportRunning(false);
    setImportError(null);
    fireAndForget(cleanupStagedFile(), "Cleanup staged file on modal close");
    onOpenChange(false);
  };

  const formatBytes = (bytes: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  };

  // Esc, the close button and a click outside all end here: none of them ends a running import
  const handleOpenChange = (next: boolean) => {
    if (!next && fragmentBusy) return;
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          "max-w-lg",
          // The plan of hundreds of files needs the room; the list scrolls, the rest stays put
          isFragment &&
            "flex max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-3xl flex-col overflow-y-auto",
        )}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Import Archive</DialogTitle>
          <DialogDescription>
            {isFragment
              ? "Recovered chats: .md files with an id in their frontmatter. Nothing is written until you confirm."
              : "Import provider backups (ChatGPT, Claude, Open WebUI, OpenRouter) or generic HAEVN formats (JSON, Markdown)."}
          </DialogDescription>
        </DialogHeader>
        <div
          className={cn(
            "mt-4 space-y-3",
            isFragment && "flex min-h-0 flex-1 flex-col gap-3 space-y-0",
          )}
        >
          <div className="flex items-center gap-2">
            <label htmlFor="importFormat" className="text-sm font-medium text-foreground">
              Format:
            </label>
            <select
              id="importFormat"
              disabled={fragmentBusy}
              className="min-w-[16rem] rounded-md border border-border bg-input p-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              value={importProvider}
              onChange={(e) =>
                setImportProvider((e.target as HTMLSelectElement).value as ImportProviderType)
              }
            >
              {formatListedUnder(importProviderFilter, "chatgpt_zip") && (
                <option value="chatgpt_zip">ChatGPT Backup (.zip)</option>
              )}
              {formatListedUnder(importProviderFilter, "claude_zip") && (
                <option value="claude_zip">Claude Backup (.zip)</option>
              )}
              {formatListedUnder(importProviderFilter, "claudecode_jsonl") && (
                <option value="claudecode_jsonl">Claude Code Session (.jsonl)</option>
              )}
              {formatListedUnder(importProviderFilter, "codex_jsonl") && (
                <option value="codex_jsonl">Codex Session (.jsonl)</option>
              )}
              {formatListedUnder(importProviderFilter, "pi_jsonl") && (
                <option value="pi_jsonl">PI Session (.jsonl)</option>
              )}
              {formatListedUnder(importProviderFilter, "fragment_md") && (
                <option value="fragment_md">Fragments (.md files or a folder)</option>
              )}
              {formatListedUnder(importProviderFilter, "openrouter_json") && (
                <option value="openrouter_json">OpenRouter Chats (.json)</option>
              )}
              {formatListedUnder(importProviderFilter, "openwebui_json") && (
                <option value="openwebui_json">Open WebUI (conversations.json file)</option>
              )}
              {formatListedUnder(importProviderFilter, "openwebui_zip") && (
                <option value="openwebui_zip">Open WebUI (.zip with conversations.json)</option>
              )}
              {!importProviderFilter && (
                <>
                  <option value="haevn_export_zip">HAEVN Export ZIP</option>
                  <option value="haevn_markdown">HAEVN Markdown</option>
                </>
              )}
            </select>
          </div>
          {isFragment && (
            <FragmentImportPanel
              focusFirst={importProviderFilter === "fragment_md"}
              onBusyChange={setFragmentBusy}
              onClose={handleClose}
              onShowFragments={onShowFragments}
              onImported={onLoadChats}
            />
          )}
          {importProvider === "chatgpt_zip" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                Archive (.zip):
              </label>
              <div
                className={dropZoneClass(isDragActive)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  try {
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    const files = dt.files?.length ? Array.from(dt.files) : [];
                    if (files.length > 0 && files[0].name.toLowerCase().endsWith(".zip")) {
                      setImportProvider("chatgpt_zip");
                      setImportFile(files[0]);
                      setStatus("Zip selected via drag-and-drop.", "ok");
                    } else {
                      setStatus("Unsupported drop. Please drop a .zip file.", "warn");
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Drag & drop ChatGPT backup .zip here, or choose a file below.
              </div>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".zip"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {(importProvider === "openwebui_zip" ||
            importProvider === "claude_zip" ||
            importProvider === "haevn_export_zip") && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                {importProvider === "openwebui_zip"
                  ? "Open WebUI ZIP (contains conversations.json):"
                  : importProvider === "claude_zip"
                    ? "Claude ZIP (contains conversations.json, optional projects.json):"
                    : importProvider === "haevn_export_zip"
                      ? "HAEVN Export ZIP (manifest.json + chats + media):"
                      : "ZIP archive:"}
              </label>
              <div
                className={dropZoneClass(isDragActive)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  try {
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    const files = dt.files?.length ? Array.from(dt.files) : [];
                    if (files.length > 0 && files[0].name.toLowerCase().endsWith(".zip")) {
                      setImportFile(files[0]);
                      setStatus("Zip selected via drag-and-drop.", "ok");
                    } else {
                      setStatus("Unsupported drop. Please drop a .zip file.", "warn");
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Drag & drop .zip file here, or choose a file below.
              </div>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".zip"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {(importProvider === "claudecode_jsonl" ||
            importProvider === "codex_jsonl" ||
            importProvider === "pi_jsonl") && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                {importProvider === "claudecode_jsonl"
                  ? "Claude Code Session (.jsonl):"
                  : importProvider === "codex_jsonl"
                    ? "Codex Session (.jsonl):"
                    : "PI Session (.jsonl):"}
              </label>
              <div
                className={dropZoneClass(isDragActive)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  try {
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    const files = dt.files?.length ? Array.from(dt.files) : [];
                    if (files.length > 0 && files[0].name.toLowerCase().endsWith(".jsonl")) {
                      setImportFile(files[0]);
                      setStatus("JSONL file selected via drag-and-drop.", "ok");
                    } else {
                      setStatus("Unsupported drop. Please drop a .jsonl file.", "warn");
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Drag & drop .jsonl file here, or choose a file below.
              </div>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".jsonl,application/x-ndjson"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {importProvider === "openrouter_json" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                OpenRouter chatroom export (.json):
              </label>
              <div
                className={dropZoneClass(isDragActive)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  try {
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    const files = dt.files?.length ? Array.from(dt.files) : [];
                    if (files.length > 0 && files[0].name.toLowerCase().endsWith(".json")) {
                      setImportFile(files[0]);
                      setStatus("JSON file selected via drag-and-drop.", "ok");
                    } else {
                      setStatus("Unsupported drop. Please drop a .json file.", "warn");
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Drag & drop the .json export here (every chatroom in it is imported), or choose a
                file below.
              </div>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".json,application/json"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {importProvider === "openwebui_json" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                Open WebUI conversations.json:
              </label>
              <div
                className={dropZoneClass(isDragActive)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  setDragActive(false);
                  try {
                    const dt = e.dataTransfer;
                    if (!dt) return;
                    const files = dt.files?.length ? Array.from(dt.files) : [];
                    if (
                      files.length > 0 &&
                      (files[0].name.toLowerCase().endsWith(".json") ||
                        files[0].type === "application/json")
                    ) {
                      setImportFile(files[0]);
                      setStatus("JSON file selected via drag-and-drop.", "ok");
                    } else {
                      setStatus("Unsupported drop. Please drop a .json file.", "warn");
                    }
                  } catch {
                    /* ignore */
                  }
                }}
              >
                Drag & drop .json file here, or choose a file below.
              </div>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".json,application/json"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {importProvider === "haevn_markdown" && (
            <div className="flex flex-col gap-2">
              <label htmlFor="importFile" className="text-sm font-medium text-foreground">
                HAEVN Markdown file:
              </label>
              <input
                id="importFile"
                type="file"
                className={FILE_INPUT_CLASS}
                accept=".md,.markdown,text/markdown"
                onChange={(e) => setImportFile((e.target as HTMLInputElement).files?.[0] || null)}
              />
              {importFile && (
                <div className="text-xs text-muted-foreground">Selected: {importFile.name}</div>
              )}
            </div>
          )}
          {!isFragment && (
            <div className="flex items-center gap-2 text-sm">
              <Checkbox
                id="overwrite"
                checked={importOverwrite}
                onCheckedChange={(on) => setImportOverwrite(on === true)}
              />
              <label htmlFor="overwrite" className="text-foreground">
                Overwrite existing chats with the same ID
              </label>
            </div>
          )}
          {!isFragment && importError && (
            <div className="mt-2 p-3 bg-destructive/10 border border-destructive/50 rounded-md">
              <div className="text-sm text-destructive font-medium">Error</div>
              <div className="text-xs text-foreground mt-1">{importError}</div>
            </div>
          )}
          {!isFragment && importRunning && (
            <div className="mt-2 space-y-2">
              <Progress
                value={
                  importProgress.total
                    ? Math.round((importProgress.processed / importProgress.total) * 100)
                    : 0
                }
              />
              <div className="text-xs text-muted-foreground">
                Processed {importProgress.processed}/{importProgress.total} • Saved{" "}
                {importProgress.saved} • Skipped {importProgress.skipped} • Errors{" "}
                {importProgress.errors}
                {importProgress.totalMedia
                  ? ` • Media ${importProgress.processedMedia || 0}/${importProgress.totalMedia}`
                  : ""}
                {importProgress.bytesWritten
                  ? ` • ${formatBytes(importProgress.bytesWritten)}${
                      importProgress.totalBytes ? `/${formatBytes(importProgress.totalBytes)}` : ""
                    }`
                  : ""}
              </div>
            </div>
          )}
        </div>
        {!isFragment && (
          <DialogFooter>
            <Button variant="outline" disabled={importRunning} onClick={handleClose}>
              Close
            </Button>
            <Button
              disabled={
                ((importProvider === "chatgpt_zip" ||
                  importProvider === "openwebui_json" ||
                  importProvider === "openwebui_zip" ||
                  importProvider === "claude_zip" ||
                  importProvider === "codex_jsonl" ||
                  importProvider === "pi_jsonl" ||
                  importProvider === "openrouter_json" ||
                  importProvider === "haevn_export_zip" ||
                  importProvider === "haevn_markdown" ||
                  importProvider === "claudecode_jsonl") &&
                  !importFile) ||
                importRunning ||
                !!importError
              }
              onClick={handleStartImport}
            >
              Start Import
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
};
