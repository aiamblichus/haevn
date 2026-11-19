/**
 * OpenRouter provider registration.
 *
 * Import-only provider for OpenRouter chatroom exports (one JSON file holding many rooms).
 */

import type { Extractor, Importer, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { parseOpenRouterExport } from "./importer";
import type { OpenRouterRawExtraction } from "./model";
import { transformOpenRouterExportToHaevnChats } from "./transformer";

const extractor: Extractor<OpenRouterRawExtraction> = {
  isPlatform: () => false,
  extractChatIdFromUrl: () => null,
  extractData: async () => {
    throw new Error("OpenRouter is import-only (no live sync)");
  },
};

const transformer: Transformer<OpenRouterRawExtraction> = {
  transform: async (raw: OpenRouterRawExtraction) => transformOpenRouterExportToHaevnChats(raw),

  validate: (raw: OpenRouterRawExtraction) => {
    const errors: string[] = [];
    if (!raw.version) errors.push("Missing version");
    if (!Array.isArray(raw.rooms) || raw.rooms.length === 0) errors.push("No rooms found");

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

const importer: Importer<string> = {
  importFromBackup: async (data: string) =>
    transformOpenRouterExportToHaevnChats(parseOpenRouterExport(data)),

  canImport: (data: unknown) => {
    return typeof data === "string" && /"version"\s*:\s*"orpg\./.test(data);
  },
};

export const openrouterProvider: Provider<OpenRouterRawExtraction, string> = {
  name: "openrouter",
  displayName: "OpenRouter",
  importOnly: true,
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
};
