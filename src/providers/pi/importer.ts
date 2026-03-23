/**
 * PI session JSONL importer.
 */

import type {
  PiLine,
  PiMessageLine,
  PiModelChangeLine,
  PiRawExtraction,
  PiSessionLine,
  PiThinkingLevelChangeLine,
} from "./model";

function toTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function isSessionLine(line: PiLine): line is PiSessionLine {
  return line.type === "session";
}

function isModelChangeLine(line: PiLine): line is PiModelChangeLine {
  return line.type === "model_change";
}

function isThinkingLevelChangeLine(line: PiLine): line is PiThinkingLevelChangeLine {
  return line.type === "thinking_level_change";
}

function isMessageLine(line: PiLine): line is PiMessageLine {
  return line.type === "message";
}

export async function parsePiJsonl(content: string): Promise<PiRawExtraction> {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const parsedLines: PiLine[] = [];
  const models = new Set<string>();

  let sessionLine: PiSessionLine | undefined;
  let latestModelProvider: string | undefined;
  let latestThinkingLevel: string | undefined;

  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as PiLine;
      parsedLines.push(parsed);

      const ts = toTimestampMs(parsed.timestamp);
      if (ts !== null) {
        if (firstTimestamp === null) firstTimestamp = ts;
        lastTimestamp = ts;
      }

      if (isSessionLine(parsed)) {
        sessionLine = parsed;
      } else if (isModelChangeLine(parsed)) {
        if (parsed.modelId) {
          models.add(parsed.modelId);
        }
        if (parsed.provider) {
          latestModelProvider = parsed.provider;
        }
      } else if (isThinkingLevelChangeLine(parsed)) {
        latestThinkingLevel = parsed.thinkingLevel;
      } else if (isMessageLine(parsed) && parsed.message?.role === "assistant") {
        if (typeof parsed.message.model === "string" && parsed.message.model) {
          models.add(parsed.message.model);
        }
        if (typeof parsed.message.provider === "string" && parsed.message.provider) {
          latestModelProvider = parsed.message.provider;
        }
      }
    } catch (error) {
      console.warn("Failed to parse PI JSONL line:", error);
    }
  }

  const createdTimestamp = firstTimestamp ?? Date.now();
  const sessionId = sessionLine?.id || `pi-${createdTimestamp}-${parsedLines.length}`;

  return {
    sessionId,
    lines: parsedLines,
    metadata: {
      createdTimestamp,
      lastModifiedTimestamp: lastTimestamp ?? createdTimestamp,
      cwd: sessionLine?.cwd,
      version: sessionLine?.version,
      modelProvider: latestModelProvider,
      models: Array.from(models),
      thinkingLevel: latestThinkingLevel,
    },
  };
}
