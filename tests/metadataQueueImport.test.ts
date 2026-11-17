import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";
import { queueGenerationForImportedChats } from "../src/services/metadataService";

const getMetadataAIConfig = vi.hoisted(() => vi.fn());

vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig,
  getStarmapConfig: vi.fn(),
}));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

async function queuedIds(): Promise<string[]> {
  return (await getDB().metadataQueue.toArray()).map((q) => q.chatId).sort();
}

beforeEach(async () => {
  getMetadataAIConfig.mockReset();
  getMetadataAIConfig.mockResolvedValue({ enabled: true, autoGenerate: true });
  vi.stubGlobal("chrome", { alarms: { create: vi.fn(), clear: vi.fn(async () => true) } });
  await Promise.all([getDB().chatMetadata.clear(), getDB().metadataQueue.clear()]);
});

describe("queueing imported chats for AI metadata (HVN-53)", () => {
  it("queues every chat when AI metadata and automatic generation are on", async () => {
    await queueGenerationForImportedChats(["a", "b"]);

    expect(await queuedIds()).toEqual(["a", "b"]);
  });

  it.each([
    ["automatic generation is off", { enabled: true, autoGenerate: false }],
    ["AI metadata is off", { enabled: false, autoGenerate: true }],
  ])("queues nothing when %s", async (_name, config) => {
    getMetadataAIConfig.mockResolvedValue(config);

    await queueGenerationForImportedChats(["a", "b"]);

    expect(await queuedIds()).toEqual([]);
  });

  it("leaves out a chat that already has metadata (one the import seeded)", async () => {
    await MetadataRepository.set("seeded", { title: "Carried", source: "manual" });

    await queueGenerationForImportedChats(["seeded", "plain"]);

    expect(await queuedIds()).toEqual(["plain"]);
  });

  it("queues the others when one chat cannot be queued, and does not reject", async () => {
    const put = vi.spyOn(getDB().metadataQueue, "put");
    put.mockRejectedValueOnce(new Error("quota"));

    try {
      await expect(queueGenerationForImportedChats(["a", "b"])).resolves.toBeUndefined();
    } finally {
      put.mockRestore();
    }

    expect(await queuedIds()).toEqual(["b"]);
  });

  it("does not reject when the settings cannot be read", async () => {
    getMetadataAIConfig.mockRejectedValue(new Error("storage gone"));

    await expect(queueGenerationForImportedChats(["a"])).resolves.toBeUndefined();

    expect(await queuedIds()).toEqual([]);
  });
});
