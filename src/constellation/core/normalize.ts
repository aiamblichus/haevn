import type { ConstellationBounds, ConstellationPoint } from "./types";

export function computeBounds(points: ConstellationPoint[]): ConstellationBounds {
  if (points.length === 0) {
    return { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }

  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function normalizePointsToUnitCube(points: ConstellationPoint[]): ConstellationPoint[] {
  const bounds = computeBounds(points);
  const rangeX = Math.max(1e-9, bounds.maxX - bounds.minX);
  const rangeY = Math.max(1e-9, bounds.maxY - bounds.minY);
  const rangeZ = Math.max(1e-9, bounds.maxZ - bounds.minZ);

  return points.map((p) => ({
    ...p,
    x: ((p.x - bounds.minX) / rangeX) * 2 - 1,
    y: ((p.y - bounds.minY) / rangeY) * 2 - 1,
    z: ((p.z - bounds.minZ) / rangeZ) * 2 - 1,
  }));
}
