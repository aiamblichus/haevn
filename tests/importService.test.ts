import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../src/model/haevn_model";
import { getDB } from "../src/services/db";
import { ImportService } from "../src/services/importService";
import * as MetadataRepository from "../src/services/metadataRepository";

const { getChat, saveChat } = vi.hoisted(() => ({
  getChat: vi.fn(),
  saveChat: vi.fn(async () => {}),
}));

vi.mock("../src/services/syncService", () => ({ SyncService: { getChat, saveChat } }));
vi.mock("../src/services/cacheService", () => ({
  CacheService: { updateProviderStats: vi.fn(async () => {}) },
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => {}),
}));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function chatWithMetadata(id: string): Chat {
  return {
    id,
    source: "claude",
    haevnMetadata: {
      title: "Carried title",
      description: "d",
      synopsis: "s",
      categories: ["c"],
      keywords: ["k"],
    },
  } as unknown as Chat;
}

beforeEach(async () => {
  getChat.mockReset();
  getChat.mockResolvedValue(undefined);
  await getDB().chatMetadata.clear();
});

describe("saving an imported chat seeds its metadata (the UI and the CLI both come through here)", () => {
  it("writes the carried haevnMetadata as a manual record", async () => {
    await ImportService.saveImportedChat(chatWithMetadata("c1"));

    expect(await MetadataRepository.get("c1")).toMatchObject({
      chatId: "c1",
      title: "Carried title",
      categories: ["c"],
      keywords: ["k"],
      source: "manual",
    });
  });

  it("never replaces a record the archive already has", async () => {
    await MetadataRepository.set("c2", { title: "Mine", source: "manual" });

    await ImportService.saveImportedChat(chatWithMetadata("c2"));

    expect(await MetadataRepository.get("c2")).toMatchObject({ title: "Mine" });
  });

  it("writes nothing for a chat that carries no metadata", async () => {
    await ImportService.saveImportedChat({ id: "c3", source: "claude" } as unknown as Chat);

    expect(await MetadataRepository.get("c3")).toBeNull();
  });
});
