import { sendWorkerRequest } from "../../utils/workerApi";
import type { ConstellationLayoutParams, ConstellationLayoutResult } from "../core/types";

/**
 * Ask the starmap worker for a layout. Only the parameters go out: the worker reads the
 * embeddings from IndexedDB itself, and only the points come back (HVN-93).
 */
export async function computeLayoutInWorker(args: {
  params: ConstellationLayoutParams;
}): Promise<ConstellationLayoutResult> {
  const requestId = `starmap_${Date.now()}_${Math.random()}`;
  const response = await sendWorkerRequest(
    "starmap",
    {
      type: "computeLayout",
      requestId,
      params: args.params,
    },
    { expectResponse: true, timeout: 60000 },
  );

  if (!response || response.type !== "layoutResult") {
    throw new Error("Starmap worker did not return a layout result");
  }

  return {
    points: response.points,
    bounds: response.bounds,
    stats: response.stats,
  };
}
