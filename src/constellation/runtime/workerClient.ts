import { sendWorkerRequest } from "../../utils/workerApi";
import type {
  ConstellationLayoutParams,
  ConstellationLayoutResult,
  ConstellationVector,
} from "../core/types";

export async function computeLayoutInWorker(args: {
  vectors: ConstellationVector[];
  params: ConstellationLayoutParams;
}): Promise<ConstellationLayoutResult> {
  const requestId = `starmap_${Date.now()}_${Math.random()}`;
  const response = await sendWorkerRequest(
    "starmap",
    {
      type: "computeLayout",
      requestId,
      vectors: args.vectors,
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
