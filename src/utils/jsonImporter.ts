/**
 * Validates and normalizes a raw parsed object into a HAEVN Chat.
 * Used when importing single-file haevn_json payloads where the input
 * is user-supplied and may be malformed or incomplete.
 */

import type { Chat } from "../model/haevn_model";

export function validateAndNormalizeChat(raw: unknown, contentHash: string): Chat {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Invalid HAEVN JSON: expected a chat object, got ${Array.isArray(raw) ? "array" : typeof raw}`,
    );
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.title !== "string" || !obj.title.trim()) {
    throw new Error('Invalid HAEVN JSON: missing or empty required field "title"');
  }

  if (!obj.messages || typeof obj.messages !== "object" || Array.isArray(obj.messages)) {
    throw new Error(
      'Invalid HAEVN JSON: "messages" must be a non-null object (message dictionary)',
    );
  }

  if (Object.keys(obj.messages as object).length === 0) {
    throw new Error("Invalid HAEVN JSON: chat has no messages");
  }

  if (typeof obj.currentId !== "string" || !obj.currentId) {
    throw new Error('Invalid HAEVN JSON: missing or empty required field "currentId"');
  }

  // Apply defaults for fields that can be synthesized
  const source = typeof obj.source === "string" && obj.source ? obj.source : "unknown";
  const sourceId = typeof obj.sourceId === "string" && obj.sourceId ? obj.sourceId : contentHash;
  const id = typeof obj.id === "string" && obj.id ? obj.id : sourceId;

  return {
    ...obj,
    id,
    source,
    sourceId,
    title: obj.title as string,
    models: Array.isArray(obj.models) ? (obj.models as string[]) : [],
    params:
      obj.params && typeof obj.params === "object" && !Array.isArray(obj.params)
        ? (obj.params as Record<string, unknown>)
        : {},
    tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : [],
    timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Date.now(),
    currentId: obj.currentId as string,
    messages: obj.messages as Chat["messages"],
    lastSyncedTimestamp:
      typeof obj.lastSyncedTimestamp === "number" ? obj.lastSyncedTimestamp : Date.now(),
    checksum: typeof obj.checksum === "string" ? obj.checksum : "",
    syncStatus: (["synced", "changed", "error", "pending", "new"] as const).includes(
      obj.syncStatus as never,
    )
      ? (obj.syncStatus as Chat["syncStatus"])
      : "synced",
    deleted: obj.deleted === 1 ? 1 : 0,
  };
}
