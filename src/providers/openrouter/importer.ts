/**
 * OpenRouter chatroom export importer.
 */

import type { OpenRouterRawExtraction, OpenRouterRoom } from "./model";

/** The export's `version` begins with this ("orpg.3.0" is the one the transformer was written for). */
const VERSION_PREFIX = "orpg.";

/** A room with no message has no root message to name its chat by, so it cannot be imported. */
export function isImportableRoom(room: OpenRouterRoom | null | undefined): boolean {
  return !!room && typeof room === "object" && Object.keys(room.messages ?? {}).length > 0;
}

export function parseOpenRouterExport(content: string): OpenRouterRawExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Not an OpenRouter chatroom export: the file is not valid JSON");
  }

  const root = parsed as { version?: unknown; rooms?: unknown } | null;
  if (
    !root ||
    typeof root !== "object" ||
    typeof root.version !== "string" ||
    !root.version.startsWith(VERSION_PREFIX) ||
    !Array.isArray(root.rooms)
  ) {
    throw new Error(
      `Not an OpenRouter chatroom export: expected {"version": "${VERSION_PREFIX}…", "rooms": [...]}`,
    );
  }

  return { version: root.version, rooms: root.rooms as OpenRouterRoom[] };
}

/** How many chats an export holds: its rooms that have a message. */
export function countOpenRouterRooms(content: string): number {
  return parseOpenRouterExport(content).rooms.filter(isImportableRoom).length;
}
