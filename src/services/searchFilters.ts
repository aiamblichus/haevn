import type { SearchFilters } from "../types/workerMessages";
import type { ChatMetadataRecord } from "./db";

/** Whether a chat's timestamp is inside the range of the filters; an absent bound is open. */
export function inDateRange(timestamp: number | undefined, filters: SearchFilters): boolean {
  const at = timestamp ?? 0;
  if (filters.after !== undefined && at < filters.after) return false;
  if (filters.before !== undefined && at > filters.before) return false;
  return true;
}

/** Whether a filter names a category the chat's metadata has to be looked up for. */
export function needsCategory(filters: SearchFilters): filters is SearchFilters & {
  category: string;
} {
  return !!filters.category && filters.category !== "all";
}

/**
 * Whether a chat's metadata puts it in the category. `_unset` is the chats that have no metadata
 * or none that was written (source "unset"); any other value is one of the chat's categories.
 */
export function inCategory(meta: ChatMetadataRecord | undefined, category: string): boolean {
  if (category === "_unset") return !meta || meta.source === "unset";
  return Array.isArray(meta?.categories) && meta.categories.includes(category);
}
