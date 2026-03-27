import type { StarmapLayoutRecord } from "../../services/db";
import { getDB } from "../../services/db";
import type { ConstellationLayoutResult } from "../core/types";

export async function getLayout(layoutKey: string): Promise<StarmapLayoutRecord | null> {
  const record = await getDB().starmapLayout.get(layoutKey);
  return record ?? null;
}

export async function saveLayout(
  layoutKey: string,
  layout: ConstellationLayoutResult,
  params: {
    umap: Record<string, unknown>;
    cluster: Record<string, unknown>;
  },
): Promise<void> {
  await getDB().starmapLayout.put({
    layoutKey,
    points: layout.points,
    bounds: layout.bounds,
    params,
    updatedAt: Date.now(),
  });
}

export async function clearLayouts(): Promise<void> {
  await getDB().starmapLayout.clear();
}
