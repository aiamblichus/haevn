/**
 * PI provider registration.
 *
 * Import-only provider for PI session JSONL files.
 */

import type { Extractor, Importer, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { parsePiJsonl } from "./importer";
import type { PiRawExtraction } from "./model";
import { transformPiToHaevnChat } from "./transformer";

const extractor: Extractor<PiRawExtraction> = {
  isPlatform: () => false,
  extractChatIdFromUrl: () => null,
  extractData: async () => {
    throw new Error("PI is import-only (no live sync)");
  },
};

const transformer: Transformer<PiRawExtraction> = {
  transform: async (raw: PiRawExtraction) => {
    return [transformPiToHaevnChat(raw)];
  },

  validate: (raw: PiRawExtraction) => {
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
    const extraction = await parsePiJsonl(data);
    return [transformPiToHaevnChat(extraction)];
  },

  canImport: (data: unknown) => {
    return (
      typeof data === "string" &&
      data.includes('"type":"session"') &&
      data.includes('"type":"message"')
    );
  },
};

export const piProvider: Provider<PiRawExtraction, string> = {
  name: "pi",
  displayName: "PI",
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
      reason: "PI is import-only (no live sync)",
    };
  },
};
