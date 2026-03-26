import { log } from "../utils/logger";
import type { ChatMetadataRecord } from "./db";
import { getDB } from "./db";

export async function get(chatId: string): Promise<ChatMetadataRecord | null> {
  const record = await getDB().chatMetadata.get(chatId);
  return record ?? null;
}

export async function getMany(chatIds: string[]): Promise<Map<string, ChatMetadataRecord>> {
  if (chatIds.length === 0) return new Map();
  const records = await getDB().chatMetadata.bulkGet(chatIds);
  const map = new Map<string, ChatMetadataRecord>();
  for (const record of records) {
    if (record) map.set(record.chatId, record);
  }
  return map;
}

export async function set(
  chatId: string,
  partial: Partial<Omit<ChatMetadataRecord, "chatId">>,
): Promise<void> {
  const existing = await getDB().chatMetadata.get(chatId);
  const now = Date.now();
  if (existing) {
    await getDB().chatMetadata.update(chatId, { ...partial, updatedAt: now });
  } else {
    await getDB().chatMetadata.put({
      chatId,
      title: "",
      description: "",
      synopsis: "",
      categories: [],
      keywords: [],
      source: "unset",
      updatedAt: now,
      ...partial,
    });
  }
}

export async function remove(chatId: string): Promise<void> {
  await getDB().chatMetadata.delete(chatId);
}

export async function removeMany(chatIds: string[]): Promise<void> {
  if (chatIds.length === 0) return;
  try {
    await getDB().chatMetadata.bulkDelete(chatIds);
  } catch (err) {
    log.warn("[MetadataRepository] Failed to bulk-delete metadata records", err);
  }
}

/** Delete every metadata record and clear the queue — used by "Rebuild All". */
export async function clearAll(): Promise<void> {
  await getDB().chatMetadata.clear();
  await getDB().metadataQueue.clear();
  log.info("[MetadataRepository] Cleared all metadata and queue");
}
