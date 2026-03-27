import type { ExporterId, ExportOptions } from "../../formatters";
import { log } from "../../utils/logger";

export interface ExporterDefinition {
  id: ExporterId;
  label: string;
  description: string;
  supportsMultiChat: boolean;
  supportsMessageSelection: boolean;
  outputKind: "zip" | "file";
}

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  exporterId: "haevn_zip",
  format: "json",
  includeMetadata: true,
  includeTimestamps: true,
};

const EXPORTERS: Record<ExporterId, ExporterDefinition> = {
  haevn_zip: {
    id: "haevn_zip",
    label: "HAEVN Archive (.zip)",
    description: "Canonical backup export with chat JSON, media assets, and manifest.",
    supportsMultiChat: true,
    supportsMessageSelection: true,
    outputKind: "zip",
  },
  haevn_json: {
    id: "haevn_json",
    label: "HAEVN JSON (.json)",
    description: "Single-chat canonical JSON export.",
    supportsMultiChat: false,
    supportsMessageSelection: true,
    outputKind: "file",
  },
  haevn_markdown: {
    id: "haevn_markdown",
    label: "HAEVN Markdown (.md)",
    description: "Single-chat readable transcript export.",
    supportsMultiChat: false,
    supportsMessageSelection: true,
    outputKind: "file",
  },
};

export function listExporters(): ExporterDefinition[] {
  return Object.values(EXPORTERS);
}

export function getExporter(exporterId: ExporterId): ExporterDefinition {
  return EXPORTERS[exporterId];
}

export function normalizeExportOptions(options?: ExportOptions): ExportOptions {
  const normalized: ExportOptions = {
    ...DEFAULT_EXPORT_OPTIONS,
    ...(options || {}),
  };

  if (!normalized.exporterId) {
    normalized.exporterId = "haevn_zip";
  }

  const exporter = EXPORTERS[normalized.exporterId];
  if (!exporter) {
    throw new Error(`Unsupported exporter: ${normalized.exporterId}`);
  }

  if (normalized.exporterId === "haevn_zip" && normalized.format !== "json") {
    log.warn("[Export] Non-JSON format requested for HAEVN ZIP exporter. Falling back to JSON.", {
      requestedFormat: normalized.format,
      exporterId: normalized.exporterId,
    });
    normalized.format = "json";
  }

  if (normalized.exporterId === "haevn_json") {
    normalized.format = "json";
  }

  if (normalized.exporterId === "haevn_markdown") {
    normalized.format = "markdown";
  }

  return normalized;
}
