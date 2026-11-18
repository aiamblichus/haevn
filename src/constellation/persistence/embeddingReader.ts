import type { Table } from "dexie";
import type { ChatEmbeddingRecord } from "../../services/db";
import type { ConstellationVector } from "../core/types";

/** Rows read per `bulkGet`: 200 x 1,536 dimensions is about 2.5 MB of JS numbers at a time. */
export const EMBEDDING_READ_BATCH = 200;

/**
 * Read every stored embedding into one Float32Array, a batch of rows at a time, so the
 * archive's vectors are never held twice (as number arrays and as Float32). The returned
 * vectors are views into that one buffer, in chat id order.
 *
 * Rows of a different dimensionality than the first are an error, as in the layout itself.
 */
export async function readEmbeddingVectors(
  table: Table<ChatEmbeddingRecord, string>,
  batchSize: number = EMBEDDING_READ_BATCH,
): Promise<ConstellationVector[]> {
  const chatIds = (await table.toCollection().primaryKeys()) as string[];
  if (chatIds.length === 0) return [];

  let dim = 0;
  let buffer = new Float32Array(0);
  const kept: string[] = [];

  for (let start = 0; start < chatIds.length; start += batchSize) {
    const rows = await table.bulkGet(chatIds.slice(start, start + batchSize));
    for (const row of rows) {
      if (!row) continue; // removed between the key scan and this read
      if (dim === 0) {
        dim = row.vector.length;
        if (dim === 0) throw new Error("Embedding vectors must be non-empty");
        buffer = new Float32Array(chatIds.length * dim);
      }
      if (row.vector.length !== dim) {
        throw new Error("Embedding vectors must all have the same dimensionality");
      }
      buffer.set(row.vector, kept.length * dim);
      kept.push(row.chatId);
    }
  }

  return kept.map((chatId, i) => ({ chatId, vector: buffer.subarray(i * dim, (i + 1) * dim) }));
}
