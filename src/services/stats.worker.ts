// Stats Worker - Offloads provider stats calculations to prevent blocking the service worker
import type { StatsWorkerMessage, StatsWorkerResponse } from "../types/workerMessages";
import { log } from "../utils/logger";
import { HaevnDatabase } from "./db";

// Use the shared database class - worker gets its own instance
const db = new HaevnDatabase();

// Calculate provider stats (runs in worker thread)
async function calculateProviderStats(providerName: string): Promise<number> {
  try {
    // Use indexed source field for exact match (O(log n) instead of O(n))
    const providerLower = providerName.toLowerCase();
    const count = await db.chats.where("source").equals(providerLower).count();
    return count;
  } catch (err) {
    log.error(`[StatsWorker] Failed to calculate stats for ${providerName}:`, err);
    return 0;
  }
}

// Calculate stats for multiple providers in parallel
async function calculateAllProviderStats(
  providerNames: string[],
): Promise<Array<{ key: string; count: number }>> {
  const promises = providerNames.map((providerName) =>
    calculateProviderStats(providerName).then((count) => ({
      key: providerName,
      count,
    })),
  );

  // Execute all calculations in parallel
  return Promise.all(promises);
}

// Message handler
self.onmessage = async (event: MessageEvent<StatsWorkerMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init": {
        // Verify database connection
        await db.chats.count();
        self.postMessage({
          type: "initComplete",
          success: true,
        } as StatsWorkerResponse);
        break;
      }

      case "getProviderStats": {
        const count = await calculateProviderStats(msg.providerName);
        self.postMessage({
          type: "providerStatsResult",
          requestId: msg.requestId,
          count,
        } as StatsWorkerResponse);
        break;
      }

      case "getAllProviderStats": {
        const stats = await calculateAllProviderStats(msg.providerNames);
        self.postMessage({
          type: "allProviderStatsResult",
          requestId: msg.requestId,
          stats,
        } as StatsWorkerResponse);
        break;
      }

      default: {
        const exhaustiveCheck: never = msg;
        self.postMessage({
          type: "error",
          error: `Unknown message type: ${exhaustiveCheck}`,
        } as StatsWorkerResponse);
      }
    }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error("[StatsWorker] Error handling message:", error);
    const requestId =
      msg.type === "getProviderStats" || msg.type === "getAllProviderStats"
        ? msg.requestId
        : undefined;
    self.postMessage({
      type: "error",
      error: errorMsg,
      requestId,
    } as StatsWorkerResponse);
  }
};
