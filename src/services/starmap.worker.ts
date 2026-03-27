import { computeConstellationLayout } from "../constellation/compute/projectAndCluster";
import type { StarmapWorkerMessage, StarmapWorkerResponse } from "../types/workerMessages";
import { log } from "../utils/logger";

self.onmessage = (event: MessageEvent<StarmapWorkerMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "ping": {
        self.postMessage({
          type: "pong",
          requestId: msg.requestId,
        } as StarmapWorkerResponse);
        return;
      }

      case "computeLayout": {
        const result = computeConstellationLayout(msg.vectors, msg.params);
        self.postMessage({
          type: "layoutResult",
          requestId: msg.requestId,
          points: result.points,
          bounds: result.bounds,
          stats: result.stats,
        } as StarmapWorkerResponse);
        return;
      }

      default: {
        const exhaustiveCheck: never = msg;
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${String(exhaustiveCheck)}`,
        } as StarmapWorkerResponse);
      }
    }
  } catch (error) {
    log.error("[StarmapWorker] Error handling message", error);
    self.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
      requestId: "requestId" in msg ? msg.requestId : undefined,
    } as StarmapWorkerResponse);
  }
};
