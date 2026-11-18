import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readEmbeddingVectors } from "../src/constellation/persistence/embeddingReader";
import type { ChatEmbeddingRecord } from "../src/services/db";
import { getDB } from "../src/services/db";

function embedding(chatId: string, vector: number[]): ChatEmbeddingRecord {
  return {
    chatId,
    vector,
    vectorDim: vector.length,
    model: "test-embed",
    endpointHash: "endpoint",
    inputFingerprint: `fingerprint-${chatId}`,
    updatedAt: 1,
  };
}

beforeEach(async () => {
  await getDB().chatEmbeddings.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readEmbeddingVectors (HVN-93)", () => {
  it("returns nothing for an empty table", async () => {
    expect(await readEmbeddingVectors(getDB().chatEmbeddings)).toEqual([]);
  });

  it("returns the vectors in chat id order as views into one Float32Array", async () => {
    await getDB().chatEmbeddings.bulkPut([
      embedding("chat-b", [0.5, 1.5]),
      embedding("chat-a", [0.25, 0.75]),
      embedding("chat-c", [2, 3]),
    ]);

    const vectors = await readEmbeddingVectors(getDB().chatEmbeddings);

    expect(vectors.map((v) => v.chatId)).toEqual(["chat-a", "chat-b", "chat-c"]);
    expect(vectors.map((v) => Array.from(v.vector))).toEqual([
      [0.25, 0.75],
      [0.5, 1.5],
      [2, 3],
    ]);
    const first = vectors[0].vector as Float32Array;
    expect(first).toBeInstanceOf(Float32Array);
    expect((vectors[2].vector as Float32Array).buffer).toBe(first.buffer);
  });

  it("reads at most one batch of rows per call", async () => {
    const table = getDB().chatEmbeddings;
    await table.bulkPut(
      Array.from({ length: 7 }, (_, i) => embedding(`chat-${i}`, [i, i + 1, i + 2])),
    );
    const bulkGet = vi.spyOn(table, "bulkGet");

    const vectors = await readEmbeddingVectors(table, 3);

    expect(vectors).toHaveLength(7);
    expect(bulkGet.mock.calls.map(([keys]) => keys.length)).toEqual([3, 3, 1]);
  });

  it("refuses rows of different dimensionality", async () => {
    await getDB().chatEmbeddings.bulkPut([embedding("a", [1, 2]), embedding("b", [1, 2, 3])]);

    await expect(readEmbeddingVectors(getDB().chatEmbeddings)).rejects.toThrow(
      "same dimensionality",
    );
  });

  it("skips a row removed between the key scan and its batch", async () => {
    const table = getDB().chatEmbeddings;
    await table.bulkPut([embedding("a", [1, 2]), embedding("b", [3, 4]), embedding("c", [5, 6])]);
    const bulkGet = table.bulkGet.bind(table);
    vi.spyOn(table, "bulkGet").mockImplementation((async (keys: string[]) => {
      const rows = await bulkGet(keys);
      return rows.map((row) => (row?.chatId === "b" ? undefined : row));
    }) as never);

    const vectors = await readEmbeddingVectors(table);

    expect(vectors.map((v) => v.chatId)).toEqual(["a", "c"]);
    expect(Array.from(vectors[1].vector)).toEqual([5, 6]);
  });
});
