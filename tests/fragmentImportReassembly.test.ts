import { beforeEach, describe, expect, it, vi } from "vitest";

// HVN-163: the import checks, before it saves a chat, that the turns give back the body that was
// read. Here the transformer is made to store a turn that is not what the file had, as a future
// parser edit that the parser's tests miss might; the file must fail on its own and nothing of it
// may be stored.

const corrupt = vi.hoisted(() => ({ title: null as string | null }));

vi.mock("../src/providers/fragment/transformer", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/providers/fragment/transformer")>();
  return {
    ...original,
    transformFragmentToHaevnChat: (
      ...args: Parameters<typeof original.transformFragmentToHaevnChat>
    ) => {
      const chat = original.transformFragmentToHaevnChat(...args);
      if (chat.title === corrupt.title) {
        const request = Object.values(chat.messages)[0]?.message[0];
        if (request?.kind === "request" && request.parts[0]?.part_kind === "user-prompt") {
          request.parts[0].content = "not what the file said";
        }
      }
      return chat;
    },
  };
});
vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig: vi.fn(async () => ({ enabled: false, autoGenerate: false })),
  getStarmapConfig: vi.fn(async () => ({ enabled: false, embeddingsEnabled: false })),
  getCliSettings: vi.fn(),
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => {}),
}));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { importFragments } from "../src/background/import/importFragments";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";
import { SyncService } from "../src/services/syncService";
import { ID_A, ID_B, withId } from "./helpers/fragmentFile";

beforeEach(async () => {
  corrupt.title = null;
  const db = getDB();
  await Promise.all([db.chats, db.chatMessages, db.chatMetadata].map((table) => table.clear()));
});

const RUN = { dryRun: false, overwrite: true, index: false };

describe("importing fragments and the body they give back (HVN-163)", () => {
  it("fails the one file whose turns do not give back its body, saves the others, and stores nothing of it", async () => {
    corrupt.title = "Broken";
    const files = [
      withId("title: Broken", "## User\nhello\n## Assistant\nworld\n", ID_A, "broken.md"),
      withId("title: Fine", "## User\nhello\n## Assistant\nworld\n", ID_B, "fine.md"),
    ];

    const result = await importFragments(files, { dryRun: false, overwrite: true, index: false });

    expect(result.imported).toMatchObject({ processed: 2, saved: 1, errors: 1 });
    expect(await SyncService.getChat(`fragment:${ID_A}`)).toBeUndefined();
    expect(await SyncService.getChat(`fragment:${ID_B}`)).toBeDefined();
  });

  it("does not touch the metadata of a changed fragment that was not saved", async () => {
    await importFragments([withId("generate: false", "## User\nold words\n", ID_A)], RUN);
    expect(await MetadataRepository.get(`fragment:${ID_A}`)).toMatchObject({ source: "manual" });

    // the next version of the file would hand the chat back to generation, but it is not saved
    corrupt.title = "";
    const result = await importFragments([withId("", "## User\nnew words\n", ID_A)], RUN);

    expect(result.imported).toMatchObject({ saved: 0, errors: 1 });
    expect(await MetadataRepository.get(`fragment:${ID_A}`)).toMatchObject({ source: "manual" });
  });

  it("saves them all when every file gives its body back", async () => {
    const files = [withId("title: Fine", "## User\nhello\n", ID_A, "fine.md")];

    const result = await importFragments(files, { dryRun: false, overwrite: true, index: false });

    expect(result.imported).toMatchObject({ saved: 1, errors: 0 });
  });
});
