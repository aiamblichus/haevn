/**
 * Claude Code JSONL importer.
 *
 * Parses Claude Code session transcript files (.jsonl) and converts them to HAEVN.Chat format.
 */

import type {
  ClaudeCodeMessage,
  ClaudeCodeRawExtraction,
  ClaudeCodeSessionMetadata,
} from "./model";
import { isAssistantMessage, isFileSnapshot, isUserMessage } from "./model";

/**
 * Parse a Claude Code JSONL file.
 *
 * @param content - Raw JSONL file content
 * @returns Parsed extraction with messages and metadata
 */
export async function parseClaudeCodeJsonl(content: string): Promise<ClaudeCodeRawExtraction> {
  const lines = content.split("\n").filter((line) => line.trim() !== "");
  const messages: ClaudeCodeMessage[] = [];
  const models = new Set<string>();
  let sessionId = "";
  let cwd = "";
  let gitBranch = "";
  let version = "";
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;

  for (const line of lines) {
    try {
      const message = JSON.parse(line) as ClaudeCodeMessage;
      messages.push(message);

      // Extract metadata from first message that has it (skip summaries, snapshots)
      // These types don't extend ClaudeCodeBaseMessage and lack sessionId/timestamp
      if (!sessionId && "sessionId" in message && message.sessionId) {
        sessionId = message.sessionId;
        cwd = (message as { cwd?: string }).cwd || "";
        gitBranch = (message as { gitBranch?: string }).gitBranch || "";
        version = (message as { version?: string }).version || "";
      }

      // Track timestamps from messages that have them
      if ("timestamp" in message && message.timestamp) {
        const ts = new Date(message.timestamp).getTime();
        if (!Number.isNaN(ts)) {
          if (firstTimestamp === null) {
            firstTimestamp = ts;
          }
          lastTimestamp = ts;
        }
      }

      // Track models used
      if (isAssistantMessage(message) && message.message.model) {
        models.add(message.message.model);
      }
    } catch (error) {
      console.warn("Failed to parse JSONL line:", line, error);
      // Continue parsing remaining lines
    }
  }

  const metadata: ClaudeCodeSessionMetadata = {
    sessionId,
    cwd,
    gitBranch,
    version,
    models: Array.from(models),
    createdTimestamp: firstTimestamp || Date.now(),
    lastModifiedTimestamp: lastTimestamp || Date.now(),
  };

  return {
    sessionId,
    messages,
    metadata,
  };
}

/**
 * Extract the session title from messages.
 * Uses the first user message content (truncated) or "Untitled Session".
 *
 * @param messages - Parsed messages
 * @returns Session title
 */
export function extractSessionTitle(messages: ClaudeCodeMessage[]): string {
  const firstUserMessage = messages.find(isUserMessage);

  if (firstUserMessage && firstUserMessage.message.content) {
    const content = firstUserMessage.message.content.trim();
    // Take first line, max 100 characters
    const firstLine = content.split("\n")[0];
    return firstLine.length > 100 ? `${firstLine.substring(0, 97)}...` : firstLine;
  }

  return "Untitled Claude Code Session";
}

/**
 * Detect subagent references in messages.
 * Looks for "Task" tool calls which spawn subagents.
 *
 * @param messages - Parsed messages
 * @returns Array of subagent IDs
 */
export function detectSubagents(messages: ClaudeCodeMessage[]): string[] {
  const subagentIds: string[] = [];

  for (const message of messages) {
    if (isAssistantMessage(message)) {
      for (const content of message.message.content) {
        if (content.type === "tool_use" && content.name === "Task") {
          // Extract subagent ID from tool call if available
          // Note: The actual subagent ID might be in tool results or file structure
          // For now, we'll detect them from the file system in the main importer
        }
      }
    }
  }

  return subagentIds;
}
