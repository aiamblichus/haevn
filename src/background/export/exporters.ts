import type { ExporterId, ExportOptions } from "../../formatters";
import { log } from "../../utils/logger";

export interface ExporterDefinition {
  id: ExporterId;
  label: string;
  description: string;
  supportsMultiChat: boolean;
  supportsMessageSelection: boolean;
  outputKind: "zip";
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

  // Phase 1: Only JSON-backed HAEVN ZIP exports are supported in extension pipeline.
  if (normalized.format !== "json") {
    log.warn("[Export] Non-JSON format requested for HAEVN ZIP exporter. Falling back to JSON.", {
      requestedFormat: normalized.format,
      exporterId: normalized.exporterId,
    });
    normalized.format = "json";
  }

  return normalized;
}
