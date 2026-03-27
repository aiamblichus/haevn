export interface ConstellationVector {
  chatId: string;
  vector: number[];
}

export interface ConstellationPoint {
  chatId: string;
  x: number;
  y: number;
  z: number;
  clusterId: number;
}

export interface ConstellationBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface ConstellationLayoutParams {
  umapNeighbors: number;
  umapMinDist: number;
  umapSeed: number;
  clusterMode: "auto" | "manual";
  clusterK: number;
}

export interface ConstellationLayoutResult {
  points: ConstellationPoint[];
  bounds: ConstellationBounds;
  stats: {
    pointCount: number;
    clusterCount: number;
    durationMs: number;
    projection: "umap";
  };
}
