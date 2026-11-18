import { computeConstellationLayout } from "../constellation/compute/projectAndCluster";
import { readEmbeddingVectors } from "../constellation/persistence/embeddingReader";
import type { StarmapWorkerMessage, StarmapWorkerResponse } from "../types/workerMessages";
import { log } from "../utils/logger";
import { getDB } from "./db";

self.onmessage = async (event: MessageEvent<StarmapWorkerMessage>) => {
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
        // The vectors never cross a message: they are read here, in batches (HVN-93)
        const readStartedAt = Date.now();
        const vectors = await readEmbeddingVectors(getDB().chatEmbeddings);
        log.debug(
          `[StarmapWorker] read ${vectors.length} embeddings in ${Date.now() - readStartedAt} ms`,
        );
        const result = computeConstellationLayout(vectors, msg.params);
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
