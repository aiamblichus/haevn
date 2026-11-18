/**
 * Chat fixtures for the CLI's tests: a message tree built from a short list of turns.
 */

import type { Chat, ChatMessage, ModelMessage, ModelResponsePart } from "../types/chat";

export interface FixtureTurn {
  id: string;
  /** The message this one answers, or null for the root. */
  parentId: string | null;
  role: "system" | "user" | "assistant";
  /** An assistant turn with empty text has no text part, as a tool call would not. */
  text: string;
  thinking?: string;
}

export interface FixtureOptions {
  id?: string;
  title?: string;
  system?: string;
  /** The message the chat is open on. Defaults to the last turn. */
  currentId?: string;
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function toModelMessages(turn: FixtureTurn): ModelMessage[] {
  if (turn.role === "system") {
    return [
      {
        kind: "request",
        parts: [{ part_kind: "system-prompt", content: turn.text, timestamp: TIMESTAMP }],
      },
    ];
  }
  if (turn.role === "user") {
    return [
      {
        kind: "request",
        parts: [{ part_kind: "user-prompt", content: turn.text, timestamp: TIMESTAMP }],
      },
    ];
  }
  const parts: ModelResponsePart[] = [];
  if (turn.thinking) parts.push({ part_kind: "thinking", content: turn.thinking });
  if (turn.text) parts.push({ part_kind: "text", content: turn.text });
  return [{ kind: "response", parts, timestamp: TIMESTAMP, model_name: "fixture-model" }];
}

/** Build a chat whose messages follow the parent links of `turns`. */
export function buildChat(turns: FixtureTurn[], options: FixtureOptions = {}): Chat {
  const chatId = options.id ?? "chat-1";
  const messages: Record<string, ChatMessage> = {};

  for (const turn of turns) {
    messages[turn.id] = {
      id: turn.id,
      chatId,
      parentId: turn.parentId ?? undefined,
      childrenIds: [],
      message: toModelMessages(turn),
      model: "fixture-model",
      done: true,
      timestamp: Date.parse(TIMESTAMP),
    };
  }
  for (const turn of turns) {
    if (turn.parentId) messages[turn.parentId]?.childrenIds.push(turn.id);
  }

  const last = turns[turns.length - 1];
  return {
    id: chatId,
    source: "claude",
    sourceId: `source-${chatId}`,
    title: options.title ?? "Fixture chat",
    models: ["fixture-model"],
    system: options.system,
    params: {},
    currentId: options.currentId ?? last?.id ?? "",
    messages,
    tags: [],
    timestamp: Date.parse(TIMESTAMP),
    lastSyncedTimestamp: Date.parse(TIMESTAMP),
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
  };
}

/** The opening question of `buildForkedChat`, longer than the 60 characters a branch keeps. */
export const LONG_OPENING =
  "Walk me through the trade-offs between a monorepo and many repositories for a small team";

/**
 * A chat that forks after its first answer:
 *   u0 → a1 → u2 → a3   (the open branch, currentId)
 *           ↘ u4 → a5
 */
export function buildForkedChat(): Chat {
  return buildChat(
    [
      { id: "u0", parentId: null, role: "user", text: LONG_OPENING },
      { id: "a1", parentId: "u0", role: "assistant", text: "first answer" },
      { id: "u2", parentId: "a1", role: "user", text: "follow up A" },
      { id: "a3", parentId: "u2", role: "assistant", text: "reply A" },
      { id: "u4", parentId: "a1", role: "user", text: "follow up B" },
      { id: "a5", parentId: "u4", role: "assistant", text: "reply B" },
    ],
    { currentId: "a3" },
  );
}
