/**
 * Codex provider registration.
 *
 * Import-only provider for Codex session JSONL files.
 */

import type { Extractor, Importer, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { parseCodexJsonl } from "./importer";
import type { CodexRawExtraction } from "./model";
import { transformCodexToHaevnChat } from "./transformer";

const extractor: Extractor<CodexRawExtraction> = {
  isPlatform: () => false,
  extractChatIdFromUrl: () => null,
  extractData: async () => {
    throw new Error("Codex is import-only (no live sync)");
  },
};

const transformer: Transformer<CodexRawExtraction> = {
  transform: async (raw: CodexRawExtraction) => {
    return [transformCodexToHaevnChat(raw)];
  },

  validate: (raw: CodexRawExtraction) => {
    const errors: string[] = [];
    if (!raw.sessionId) errors.push("Missing sessionId");
    if (!raw.lines || raw.lines.length === 0) errors.push("No lines found");

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

const importer: Importer<string> = {
  importFromBackup: async (data: string) => {
    const extraction = await parseCodexJsonl(data);
    return [transformCodexToHaevnChat(extraction)];
  },

  canImport: (data: unknown) => {
    return typeof data === "string" && data.includes('"type":"session_meta"');
  },
};

export const codexProvider: Provider<CodexRawExtraction, string> = {
  name: "codex",
  displayName: "Codex",
  extractor,
  transformer,
  importer,
  setup() {
    // No setup needed for import-only provider
  },
  getListUrl(): string {
    return "";
  },
  buildChatUrl(): string {
    return "";
  },
  async checkAvailability() {
    return {
      available: false,
      reason: "Codex is import-only (no live sync)",
    };
  },
};
