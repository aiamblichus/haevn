import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getImportJobState,
  handleWorkerResponse,
} from "../src/background/import/importOrchestrator";
import { safeSendMessage } from "../src/background/utils/messageUtils";
import { getStorageAdapter, MemoryStorageAdapter, setStorageAdapter } from "../src/storage";
import type { ImportWorkerResponse } from "../src/types/workerMessages";

vi.mock("../src/background/utils/messageUtils", () => ({ safeSendMessage: vi.fn() }));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => undefined),
}));
vi.mock("../src/services/metadataService", () => ({
  queueGeneration: vi.fn(async () => undefined),
}));
vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig: vi.fn(async () => ({ enabled: false, autoGenerate: false })),
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: { finishBulkSyncIndexing: vi.fn(async () => undefined) },
}));

// The orchestrator keeps its job state under this key in the storage adapter.
const JOB_STATE_KEY = "import_job_state";

async function startJob(): Promise<void> {
  await getStorageAdapter().set(JOB_STATE_KEY, {
    status: "running",
    importType: "chatgpt_zip",
    totalChats: 3,
    processedChats: 0,
    savedChats: 0,
    skippedChats: 0,
    errorChats: 0,
    startTime: 0,
    lastUpdateTime: 0,
  });
}

function sentEvents(action: string): Record<string, unknown>[] {
  return vi
    .mocked(safeSendMessage)
    .mock.calls.map((call) => call[0] as Record<string, unknown>)
    .filter((msg) => msg.action === action);
}

describe("import job counts", () => {
  beforeEach(async () => {
    setStorageAdapter(new MemoryStorageAdapter());
    vi.mocked(safeSendMessage).mockClear();
    await startJob();
  });

  it("counts a chat that failed to parse or save as an error, apart from a skipped duplicate", async () => {
    await handleWorkerResponse({
      type: "failed",
      chatId: "chat-bad",
      reason: "Unexpected token",
    } as ImportWorkerResponse);
    await handleWorkerResponse({
      type: "skipped",
      chatId: "chat-dup",
      reason: "Chat already exists (not overwriting)",
    } as ImportWorkerResponse);

    const state = await getImportJobState();
    expect(state?.errorChats).toBe(1);
    expect(state?.skippedChats).toBe(1);
  });

  it("carries the error count on the progress event", async () => {
    await handleWorkerResponse({
      type: "failed",
      chatId: "a",
      reason: "bad",
    } as ImportWorkerResponse);
    await handleWorkerResponse({
      type: "failed",
      chatId: "b",
      reason: "bad",
    } as ImportWorkerResponse);
    await handleWorkerResponse({
      type: "progress",
      processed: 2,
      total: 3,
      status: "Processed 2/3 conversations",
    } as ImportWorkerResponse);

    expect(sentEvents("importProgress").at(-1)).toMatchObject({
      processed: 2,
      skipped: 0,
      errors: 2,
    });
  });

  it("carries the error count on the complete event", async () => {
    await handleWorkerResponse({
      type: "failed",
      chatId: "a",
      reason: "bad",
    } as ImportWorkerResponse);
    await handleWorkerResponse({
      type: "complete",
      processed: 2,
      saved: 1,
      skipped: 0,
      errors: 1,
    } as ImportWorkerResponse);

    expect(sentEvents("importComplete")).toEqual([
      expect.objectContaining({ saved: 1, skipped: 0, errors: 1 }),
    ]);
  });
});
