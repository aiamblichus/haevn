/**
 * Codex session JSONL importer.
 */

import type { CodexLine, CodexRawExtraction, CodexSessionMetaPayload } from "./model";

function toTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export async function parseCodexJsonl(content: string): Promise<CodexRawExtraction> {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsedLines: CodexLine[] = [];
  const models = new Set<string>();
  let meta: CodexSessionMetaPayload | undefined;
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as CodexLine;
      parsedLines.push(parsed);

      const ts = toTimestampMs(parsed.timestamp);
      if (ts !== null) {
        if (firstTimestamp === null) firstTimestamp = ts;
        lastTimestamp = ts;
      }

      if (parsed.type === "session_meta" && parsed.payload) {
        meta = parsed.payload;
        const metaTs = toTimestampMs(parsed.payload.timestamp);
        if (metaTs !== null) {
          if (firstTimestamp === null || metaTs < firstTimestamp) {
            firstTimestamp = metaTs;
          }
          if (lastTimestamp === null || metaTs > lastTimestamp) {
            lastTimestamp = metaTs;
          }
        }
      }

      if (
        parsed.type === "turn_context" &&
        parsed.payload &&
        typeof parsed.payload.model === "string" &&
        parsed.payload.model
      ) {
        models.add(parsed.payload.model);
      }
    } catch (error) {
      console.warn("Failed to parse Codex JSONL line:", error);
    }
  }

  const createdTimestamp = firstTimestamp ?? Date.now();
  const sessionId = meta?.id || `codex-${createdTimestamp}-${parsedLines.length}`;

  return {
    sessionId,
    lines: parsedLines,
    metadata: {
      createdTimestamp,
      lastModifiedTimestamp: lastTimestamp ?? createdTimestamp,
      cwd: meta?.cwd,
      originator: meta?.originator,
      cliVersion: meta?.cli_version,
      source: meta?.source,
      modelProvider: meta?.model_provider,
      models: Array.from(models),
      baseInstructions: meta?.base_instructions?.text,
    },
  };
}
