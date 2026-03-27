import { UMAP } from "umap-js";
import { computeBounds, normalizePointsToUnitCube } from "../core/normalize";
import type {
  ConstellationLayoutParams,
  ConstellationLayoutResult,
  ConstellationPoint,
  ConstellationVector,
} from "../core/types";

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

function assertVectorShape(vectors: ConstellationVector[]): void {
  if (vectors.length === 0) return;
  const dim = vectors[0].vector.length;
  if (dim === 0) {
    throw new Error("Embedding vectors must be non-empty");
  }

  for (const row of vectors) {
    if (row.vector.length !== dim) {
      throw new Error("Embedding vectors must all have the same dimensionality");
    }
  }
}

function projectTo3D(
  vectors: ConstellationVector[],
  params: ConstellationLayoutParams,
): number[][] {
  if (vectors.length === 0) return [];
  if (vectors.length === 1) return [[0, 0, 0]];
  if (vectors.length === 2)
    return [
      [-1, 0, 0],
      [1, 0, 0],
    ];

  const minDist = clamp(params.umapMinDist, 0.0001, 0.99);
  const nNeighbors = clamp(params.umapNeighbors, 2, vectors.length - 1);

  const umap = new UMAP({
    nComponents: 3,
    nNeighbors,
    minDist,
    random: seededRandom(params.umapSeed),
  });

  const embedding = umap.fit(vectors.map((v) => v.vector));
  if (!Array.isArray(embedding) || embedding.length !== vectors.length) {
    throw new Error("UMAP failed to produce a valid embedding");
  }

  return embedding;
}

function squaredDistance3(a: number[], b: number[]): number {
  const dx = (a[0] || 0) - (b[0] || 0);
  const dy = (a[1] || 0) - (b[1] || 0);
  const dz = (a[2] || 0) - (b[2] || 0);
  return dx * dx + dy * dy + dz * dz;
}

function chooseAutoK(n: number): number {
  if (n <= 4) return 1;
  return clamp(Math.round(Math.sqrt(n / 2)), 2, Math.min(24, n));
}

function kMeans3(points: number[][], k: number, seed: number): number[] {
  const n = points.length;
  if (n === 0) return [];
  const kk = clamp(k, 1, n);

  const rnd = seededRandom(seed + 17);
  const centroids: number[][] = [];
  const picked = new Set<number>();

  while (centroids.length < kk) {
    const idx = Math.floor(rnd() * n);
    if (picked.has(idx)) continue;
    picked.add(idx);
    centroids.push([points[idx][0], points[idx][1], points[idx][2]]);
  }

  const labels = new Array<number>(n).fill(0);

  for (let iter = 0; iter < 15; iter++) {
    let changed = false;

    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let c = 0; c < kk; c++) {
        const d = squaredDistance3(points[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }

    const next = new Array(kk).fill(null).map(() => [0, 0, 0]);
    const counts = new Array<number>(kk).fill(0);

    for (let i = 0; i < n; i++) {
      const label = labels[i];
      next[label][0] += points[i][0];
      next[label][1] += points[i][1];
      next[label][2] += points[i][2];
      counts[label] += 1;
    }

    for (let c = 0; c < kk; c++) {
      if (counts[c] === 0) continue;
      centroids[c][0] = next[c][0] / counts[c];
      centroids[c][1] = next[c][1] / counts[c];
      centroids[c][2] = next[c][2] / counts[c];
    }

    if (!changed) break;
  }

  return labels;
}

export function computeConstellationLayout(
  vectors: ConstellationVector[],
  params: ConstellationLayoutParams,
): ConstellationLayoutResult {
  const startedAt = Date.now();

  if (vectors.length === 0) {
    return {
      points: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      stats: { pointCount: 0, clusterCount: 0, durationMs: 0, projection: "umap" },
    };
  }

  assertVectorShape(vectors);

  const projected = projectTo3D(vectors, params);
  const k = params.clusterMode === "manual" ? params.clusterK : chooseAutoK(projected.length);
  const labels = kMeans3(projected, k, params.umapSeed);

  const rawPoints: ConstellationPoint[] = vectors.map((v, idx) => ({
    chatId: v.chatId,
    x: projected[idx][0] || 0,
    y: projected[idx][1] || 0,
    z: projected[idx][2] || 0,
    clusterId: labels[idx] || 0,
  }));

  const points = normalizePointsToUnitCube(rawPoints);
  const bounds = computeBounds(points);
  const distinctClusters = new Set(points.map((p) => p.clusterId));

  return {
    points,
    bounds,
    stats: {
      pointCount: points.length,
      clusterCount: distinctClusters.size,
      durationMs: Date.now() - startedAt,
      projection: "umap",
    },
  };
}
