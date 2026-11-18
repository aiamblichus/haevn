import type {
  ConstellationLayoutParams,
  ConstellationLayoutResult,
} from "../constellation/core/types";
import { computeLayoutInWorker } from "../constellation/runtime/workerClient";
import { getDB } from "./db";
import { getStarmapConfig } from "./settingsService";

function configToLayoutParams(
  config: Awaited<ReturnType<typeof getStarmapConfig>>,
): ConstellationLayoutParams {
  return {
    umapNeighbors: config.umapNeighbors,
    umapMinDist: config.umapMinDist,
    umapSeed: config.umapSeed,
    clusterMode: config.clusterMode,
    clusterK: config.clusterK,
  };
}

export async function computeStarmapLayoutFromEmbeddings(args?: {
  paramsOverride?: Partial<ConstellationLayoutParams>;
}): Promise<ConstellationLayoutResult> {
  const [config, embeddingCount] = await Promise.all([
    getStarmapConfig(),
    getDB().chatEmbeddings.count(),
  ]);

  if (embeddingCount === 0) {
    return {
      points: [],
      bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 },
      stats: { pointCount: 0, clusterCount: 0, durationMs: 0, projection: "umap" },
    };
  }

  const params: ConstellationLayoutParams = {
    ...configToLayoutParams(config),
    ...(args?.paramsOverride ?? {}),
  };

  // The vectors stay in IndexedDB: the worker reads them itself (HVN-93)
  return computeLayoutInWorker({ params });
}
