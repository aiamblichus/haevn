import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackgroundResponse } from "../src/types/messaging";

const { startBulkSyncIndexing, finishBulkSyncIndexing } = vi.hoisted(() => ({
  startBulkSyncIndexing: vi.fn(async () => {}),
  finishBulkSyncIndexing: vi.fn(async () => {}),
}));

vi.mock("../src/services/syncService", () => ({
  SyncService: { startBulkSyncIndexing, finishBulkSyncIndexing },
}));
vi.mock("../src/services/importService", () => ({ ImportService: {} }));
vi.mock("../src/services/metadataRepository", () => ({}));
vi.mock("../src/background/import/importOrchestrator", () => ({}));

import {
  handleFinishBulkIndexing,
  handleStartBulkIndexing,
} from "../src/background/handlers/importHandlers";

describe("importHandlers bulk indexing", () => {
  beforeEach(() => {
    startBulkSyncIndexing.mockClear();
    finishBulkSyncIndexing.mockClear();
  });

  it("starts bulk indexing through SyncService", async () => {
    const sendResponse = vi.fn<(response: BackgroundResponse) => void>();

    await handleStartBulkIndexing({ action: "startBulkIndexing" }, sendResponse);

    expect(startBulkSyncIndexing).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("finishes bulk indexing through SyncService", async () => {
    const sendResponse = vi.fn<(response: BackgroundResponse) => void>();

    await handleFinishBulkIndexing({ action: "finishBulkIndexing" }, sendResponse);

    expect(finishBulkSyncIndexing).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("reports a failure to finish instead of leaving the import waiting", async () => {
    finishBulkSyncIndexing.mockRejectedValueOnce(new Error("index worker gone"));
    const sendResponse = vi.fn<(response: BackgroundResponse) => void>();

    await handleFinishBulkIndexing({ action: "finishBulkIndexing" }, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ success: false, error: "index worker gone" });
  });
});
