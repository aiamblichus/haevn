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

function buildProjectionAxes(dim: number, seed: number): [number[], number[], number[]] {
  const rnd = seededRandom(seed);
  const axisX = new Array<number>(dim);
  const axisY = new Array<number>(dim);
  const axisZ = new Array<number>(dim);

  for (let i = 0; i < dim; i++) {
    axisX[i] = rnd() * 2 - 1;
    axisY[i] = rnd() * 2 - 1;
    axisZ[i] = rnd() * 2 - 1;
  }

  return [axisX, axisY, axisZ];
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/**
 * Placeholder UMAP adapter for the first implementation slice.
 * We preserve the UMAP-facing API but use deterministic random projection until
 * we wire an actual UMAP dependency in the next pass.
 */
function projectTo3D(
  vectors: ConstellationVector[],
  params: ConstellationLayoutParams,
): number[][] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].vector.length;
  const [ax, ay, az] = buildProjectionAxes(dim, params.umapSeed);
  return vectors.map((v) => [dot(v.vector, ax), dot(v.vector, ay), dot(v.vector, az)]);
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
