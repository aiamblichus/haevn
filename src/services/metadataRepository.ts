import type { Chat } from "../model/haevn_model";
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

/**
 * Seed a chat's metadata record from the `haevnMetadata` it carries (a HAEVN export writes it),
 * as a manual record, and never over a record the archive already has. Never rejects: the chat
 * is saved, and an import must not count it as failed or undo its other work over this. Returns
 * whether a record was written. The archive's import job (in its worker) and `ImportService`
 * (the UI's and the CLI's imports) both call this.
 */
export async function seedFromChat(chat: Pick<Chat, "id" | "haevnMetadata">): Promise<boolean> {
  const carried = chat.haevnMetadata;
  if (!carried || !chat.id) return false;
  try {
    if (await get(chat.id)) return false;
    await set(chat.id, {
      title: carried.title ?? "",
      description: carried.description ?? "",
      synopsis: carried.synopsis ?? "",
      categories: carried.categories ?? [],
      keywords: carried.keywords ?? [],
      source: "manual",
      updatedAt: Date.now(),
    });
    return true;
  } catch (err) {
    log.warn(`[MetadataRepository] Failed to seed metadata for ${chat.id}`, err);
    return false;
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

/**
 * Delete every metadata record and clear metadata/embedding queues and caches.
 * Used by "Rebuild All".
 */
export async function clearAll(): Promise<void> {
  await getDB().chatMetadata.clear();
  await getDB().metadataQueue.clear();
  await getDB().chatEmbeddings.clear();
  await getDB().embeddingQueue.clear();
  await getDB().starmapLayout.clear();
  log.info("[MetadataRepository] Cleared metadata, embedding cache, and queues");
}
