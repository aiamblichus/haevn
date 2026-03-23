/**
 * Claude Code provider registration.
 *
 * This is an import-only provider - no sync/bulk sync functionality.
 */

import type { Extractor, Importer, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import { parseClaudeCodeJsonl } from "./importer";
import type { ClaudeCodeRawExtraction } from "./model";
import { transformToHaevnChat } from "./transformer";

// Stub extractor (Claude Code is import-only, no live sync)
const extractor: Extractor<ClaudeCodeRawExtraction> = {
  isPlatform: () => false, // Never active in browser

  extractChatIdFromUrl: () => null,

  extractData: async () => {
    throw new Error("Claude Code is import-only (no live sync)");
  },
};

// Transformer implementation
const transformer: Transformer<ClaudeCodeRawExtraction> = {
  transform: async (raw: ClaudeCodeRawExtraction) => {
    const chat = transformToHaevnChat(raw);
    return [chat];
  },

  validate: (raw: ClaudeCodeRawExtraction) => {
    const errors: string[] = [];

    if (!raw.sessionId) {
      errors.push("Missing sessionId");
    }

    if (!raw.messages || raw.messages.length === 0) {
      errors.push("No messages found");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  },
};

const importer: Importer<string> = {
  importFromBackup: async (data: string) => {
    const extraction = await parseClaudeCodeJsonl(data);
    return [transformToHaevnChat(extraction)];
  },

  canImport: (data: unknown) => {
    return typeof data === "string" && data.includes('"sessionId"');
  },
};

/**
 * Claude Code provider definition.
 *
 * Import-only provider for Claude Code session transcripts (.jsonl files).
 */
export const claudeCodeProvider: Provider<ClaudeCodeRawExtraction> = {
  name: "claudecode",
  displayName: "Claude Code",

  extractor,
  transformer,
  importer,

  setup() {
    // No setup needed for import-only provider
  },

  getListUrl(): string {
    return ""; // No web URL
  },

  buildChatUrl(): string {
    return ""; // No web URL
  },

  async checkAvailability() {
    return {
      available: false,
      reason: "Claude Code is import-only (no live sync)",
    };
  },
};
