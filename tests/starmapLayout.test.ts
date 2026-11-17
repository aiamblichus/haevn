import { describe, expect, it } from "vitest";
import { computeConstellationLayout } from "../src/constellation/compute/projectAndCluster";
import type {
  ConstellationLayoutParams,
  ConstellationPoint,
  ConstellationVector,
} from "../src/constellation/core/types";

const PARAMS: ConstellationLayoutParams = {
  umapNeighbors: 15,
  umapMinDist: 0.1,
  umapSeed: 42,
  clusterMode: "auto",
  clusterK: 12,
};

/** A small seeded generator, so the test vectors are the same on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** `count` chats in `groups` loose clusters, each lit on its own axis of an 8-dimensional space. */
function chats(count: number, groups = 3): ConstellationVector[] {
  const next = seeded(7);
  return Array.from({ length: count }, (_, i) => {
    const group = i % groups;
    const vector = Array.from({ length: 8 }, (_, d) => (d === group ? 10 : 0) + (next() - 0.5));
    return { chatId: `chat-${i}`, vector };
  });
}

function chatIds(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `chat-${i}`);
}

/** One point per chat, in input order, with every coordinate finite and inside the unit cube. */
function expectPlaced(points: ConstellationPoint[], ids: string[]): void {
  expect(points.map((p) => p.chatId)).toEqual(ids);
  for (const p of points) {
    for (const value of [p.x, p.y, p.z]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-1);
      expect(value).toBeLessThanOrEqual(1);
    }
  }
}

describe("starmap layout (HVN-27)", () => {
  it("returns no points and zero bounds for an empty archive", () => {
    const layout = computeConstellationLayout([], PARAMS);

    expect(layout.points).toEqual([]);
    expect(layout.bounds).toEqual({ minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
    expect(layout.stats.pointCount).toBe(0);
  });

  it("places one chat, and then two, at finite coordinates without throwing", () => {
    // One and two chats are placed by hand, not by UMAP; both paths must still give finite points.
    const one = computeConstellationLayout(chats(1), PARAMS);
    expectPlaced(one.points, chatIds(1));

    const two = computeConstellationLayout(chats(2), PARAMS);
    expectPlaced(two.points, chatIds(2));
    expect(two.points[0].x).not.toBe(two.points[1].x);
  });

  it("lays out three to six chats when the neighbour count is larger than the archive", () => {
    // The settings allow up to 200 neighbours; the layout must clamp that to the archive size.
    for (const count of [3, 4, 5, 6]) {
      const layout = computeConstellationLayout(chats(count), { ...PARAMS, umapNeighbors: 200 });
      expectPlaced(layout.points, chatIds(count));
    }
  });

  it("places each chat of a 40-chat archive once, and fills the unit cube", () => {
    const input = chats(40);
    const layout = computeConstellationLayout(input, PARAMS);

    expectPlaced(
      layout.points,
      input.map((c) => c.chatId),
    );
    expect(layout.stats.pointCount).toBe(40);
    expect(new Set(layout.points.map((p) => p.clusterId)).size).toBe(layout.stats.clusterCount);
    expect(layout.bounds).toEqual({ minX: -1, maxX: 1, minY: -1, maxY: 1, minZ: -1, maxZ: 1 });
  });

  it("gives the same layout for the same vectors and seed", () => {
    const first = computeConstellationLayout(chats(40), PARAMS);
    const second = computeConstellationLayout(chats(40), PARAMS);

    expect(second.points).toEqual(first.points);
    expect(second.bounds).toEqual(first.bounds);
  });

  it("projects the chats differently under another seed, because the seed is a setting", () => {
    // Compare coordinates alone: the seed also drives k-means, which can move cluster ids on its own.
    const coordinates = (points: ConstellationPoint[]) => points.map((p) => [p.x, p.y, p.z]);
    const first = computeConstellationLayout(chats(40), PARAMS);
    const other = computeConstellationLayout(chats(40), { ...PARAMS, umapSeed: 7 });

    expect(coordinates(other.points)).not.toEqual(coordinates(first.points));
  });

  it("uses exactly the number of clusters the user sets in manual mode", () => {
    const layout = computeConstellationLayout(chats(45), {
      ...PARAMS,
      clusterMode: "manual",
      clusterK: 3,
    });

    expect(layout.stats.clusterCount).toBe(3);
  });

  it("refuses vectors of different lengths, rather than laying out a mixture", () => {
    const mixed: ConstellationVector[] = [
      { chatId: "a", vector: [1, 2] },
      { chatId: "b", vector: [1, 2, 3] },
    ];

    expect(() => computeConstellationLayout(mixed, PARAMS)).toThrow(
      "Embedding vectors must all have the same dimensionality",
    );
  });
});
