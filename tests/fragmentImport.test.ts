import { beforeEach, describe, expect, it, vi } from "vitest";

// HVN-163: importing fragments through the real archive: the plan, the batch, the services and
// Dexie (fake-indexeddb) are real. What is not: the search index (every import here skips it; the
// search is checked on an index of its own below), thumbnails, and the broadcast.

const config = vi.hoisted(() => ({
  metadata: { enabled: true, autoGenerate: true, indexMissing: false },
}));

vi.mock("../src/services/settingsService", () => ({
  getMetadataAIConfig: vi.fn(async () => ({ ...config.metadata })),
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
import { acquireOperationLock, getActiveOperation } from "../src/background/state";
import { generateExportContent } from "../src/formatters";
import type { Chat } from "../src/model/haevn_model";
import { roughDateOf } from "../src/model/roughDate";
import {
  type FragmentFile,
  type FragmentParams,
  reassembleFragment,
} from "../src/providers/fragment";
import { getDB } from "../src/services/db";
import * as MetadataRepository from "../src/services/metadataRepository";
import { enqueueAllMissing } from "../src/services/metadataService";
import { extractIndexedChat } from "../src/services/searchDocument";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildQueryPlan } from "../src/services/searchWorkerQuery";
import { SyncService } from "../src/services/syncService";
import { ID_A, ID_B, ID_C, withId } from "./helpers/fragmentFile";
import { sqliteKit } from "./helpers/indexKit";

const RUN = { dryRun: false, overwrite: true, index: false };
const DRY = { ...RUN, dryRun: true };

const chatId = (id: string) => `fragment:${id}`;

async function fullChat(id: string): Promise<Chat> {
  const chat = await SyncService.getChatWithMessages(chatId(id));
  if (!chat) throw new Error(`no fragment ${id} in the archive`);
  return chat;
}

const states = (plan: { state: string }[]) => plan.map((e) => e.state);

beforeEach(async () => {
  config.metadata = { enabled: true, autoGenerate: true, indexMissing: false };
  const db = getDB();
  await Promise.all(
    [db.chats, db.chatMessages, db.chatMetadata, db.metadataQueue].map((table) => table.clear()),
  );
});

describe("importing fragments (HVN-163)", () => {
  it("saves a new fragment as a chat under fragment:<id>, and a second import writes nothing", async () => {
    const files = [
      withId("title: One\nmodel: m\ndate: 2024", "## User\nhi\n## Assistant\nho\n", ID_A, "a.md"),
      withId("", "just a block\n", ID_B, "b.md"),
    ];

    const first = await importFragments(files, RUN);
    expect(states(first.plan)).toEqual(["new", "new"]);
    expect(first.imported).toMatchObject({ processed: 2, saved: 2, skipped: 0, errors: 0 });
    const stored = await SyncService.getChatsBySource("fragment");
    expect(stored.map((c) => c.id).sort()).toEqual([chatId(ID_A), chatId(ID_B)].sort());

    const before = await getDB().chats.toArray();
    const second = await importFragments(files, RUN);

    expect(states(second.plan)).toEqual(["unchanged", "unchanged"]);
    expect(second.imported).toBeUndefined();
    // nothing was written: not even the time of the last sync
    expect(await getDB().chats.toArray()).toEqual(before);
  });

  it("writes nothing on a dry run, and takes no lock", async () => {
    const result = await importFragments([withId("", "words\n")], DRY);

    expect(states(result.plan)).toEqual(["new"]);
    expect(result.imported).toBeUndefined();
    expect(await getDB().chats.count()).toBe(0);
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("does not stop the other files when one is refused, and says which and why", async () => {
    const result = await importFragments(
      [{ name: "bare.md", content: "no frontmatter\n" }, withId("", "fine\n", ID_B, "ok.md")],
      RUN,
    );

    expect(result.plan.map((e) => [e.name, e.state])).toEqual([
      ["bare.md", "no-id"],
      ["ok.md", "new"],
    ]);
    expect(result.plan[0].message).toMatch(/no frontmatter/);
    expect(result.imported?.saved).toBe(1);
    expect(await SyncService.getChat(chatId(ID_B))).toBeDefined();
  });

  it("is refused as the other imports are when another operation holds the lock", async () => {
    await acquireOperationLock("bulkSync");
    await expect(importFragments([withId("", "x\n")], RUN)).rejects.toThrow(/Another operation/);
    expect(await getActiveOperation()).toBe("bulkSync");
    expect(await getDB().chats.count()).toBe(0);
  });

  it("replaces the messages of a fragment whose file changed, under the same id", async () => {
    await importFragments([withId("", "## User\none\n## Assistant\ntwo\n")], RUN);
    expect(Object.keys((await fullChat(ID_A)).messages)).toHaveLength(2);

    const result = await importFragments(
      [withId("", "## User\none\n## Assistant\ntwo\n## User\nthree\n")],
      RUN,
    );

    expect(states(result.plan)).toEqual(["changed"]);
    const chat = await fullChat(ID_A);
    expect(Object.keys(chat.messages)).toEqual(["t0001", "t0002", "t0003"]);
    expect(await getDB().chats.count()).toBe(1);
  });

  it("leaves a changed fragment as it is with --no-overwrite, and still saves the new ones", async () => {
    await importFragments([withId("", "old text\n", ID_A)], RUN);

    const result = await importFragments(
      [withId("", "new text\n", ID_A, "a.md"), withId("", "another\n", ID_B, "b.md")],
      { ...RUN, overwrite: false },
    );

    expect(states(result.plan)).toEqual(["changed", "new"]);
    expect(result.imported).toMatchObject({ saved: 1, skipped: 1 });
    expect(reassembleFragment(await fullChat(ID_A))).toBe("old text\n");
  });

  it("brings a stored fragment up to date when the parser that stored it was older", async () => {
    await importFragments([withId("", "same bytes\n")], RUN);
    const row = await getDB().chats.get(chatId(ID_A));
    await getDB().chats.put({
      ...row,
      params: { ...row?.params, fragment: { ...(row?.params.fragment as object), v: 0 } },
    } as Chat);

    const result = await importFragments([withId("", "same bytes\n")], RUN);

    expect(states(result.plan)).toEqual(["changed"]);
    expect((await SyncService.getChat(chatId(ID_A)))?.params.fragment).toMatchObject({ v: 1 });
  });

  it("brings a fragment back that was deleted in the app: importing its file again does, changed or not", async () => {
    await importFragments([withId("", "words\n")], RUN);
    await SyncService.deleteChats([chatId(ID_A)]);
    expect(await SyncService.getChat(chatId(ID_A))).toBeUndefined();

    const result = await importFragments([withId("", "words\n")], RUN);

    expect(states(result.plan)).toEqual(["new"]);
    expect(await SyncService.getChat(chatId(ID_A))).toBeDefined();
  });

  it("warns, and still imports, a new file whose text another fragment already has", async () => {
    await importFragments([withId("", "the same words\n", ID_A, "first.md")], RUN);

    const result = await importFragments([withId("", "the same words\n", ID_B, "copy.md")], RUN);

    expect(states(result.plan)).toEqual(["new"]);
    expect(result.plan[0].warnings[0]).toMatchObject({ code: "copy" });
    expect(result.plan[0].warnings[0].message).toContain("first.md");
    expect(result.imported?.saved).toBe(1);
  });
});

describe("a fragment can only replace a fragment", () => {
  it("leaves a synced chat of another provider alone when the frontmatter id is its id", async () => {
    const claude = {
      id: ID_A,
      source: "claude",
      sourceId: ID_A,
      title: "A synced chat",
      models: [],
      params: {},
      currentId: "m1",
      messages: {},
      tags: [],
      timestamp: 5,
      lastSyncedTimestamp: 5,
      providerLastModifiedTimestamp: 5,
      checksum: "x",
      syncStatus: "synced",
      deleted: 0,
    } as Chat;
    await getDB().chats.put(claude);

    await importFragments([withId("title: Recovered", "words\n", ID_A)], RUN);

    expect(await getDB().chats.get(ID_A)).toEqual(claude);
    expect((await SyncService.getChat(chatId(ID_A)))?.title).toBe("Recovered");
  });
});

describe("the metadata a file gives, and the file as the source of truth", () => {
  it("seeds a record that is the person's from a title, and queues nothing", async () => {
    await importFragments([withId("title: Named", "words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      title: "Named",
      source: "manual",
    });
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("queues a file that gives none, when automatic generation is on, with an empty title", async () => {
    await importFragments([withId("", "words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toBeNull();
    expect((await SyncService.getChat(chatId(ID_A)))?.title).toBe("");
    expect((await getDB().metadataQueue.toArray()).map((q) => q.chatId)).toEqual([chatId(ID_A)]);
  });

  it("queues nothing when generation is off, and the chat keeps its empty title", async () => {
    config.metadata = { enabled: true, autoGenerate: false, indexMissing: false };
    await importFragments([withId("", "words\n")], RUN);

    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("is kept out of every automatic path by generate: false, the sweep included", async () => {
    config.metadata = { enabled: true, autoGenerate: true, indexMissing: true };
    await importFragments([withId("generate: false", "words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      source: "manual",
      title: "",
    });
    expect(await getDB().metadataQueue.count()).toBe(0);
    expect(await enqueueAllMissing()).toBe(0);
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("hands a chat back to generation when its file stops saying generate: false", async () => {
    await importFragments([withId("generate: false", "words\n")], RUN);
    expect(await getDB().metadataQueue.count()).toBe(0);

    const result = await importFragments([withId("", "more words\n")], RUN);

    expect(states(result.plan)).toEqual(["changed"]);
    expect(await MetadataRepository.get(chatId(ID_A))).toBeNull();
    expect((await getDB().metadataQueue.toArray()).map((q) => q.chatId)).toEqual([chatId(ID_A)]);
  });

  it("keeps a record the person made out of it, when the file stops saying generate: false", async () => {
    await importFragments([withId("generate: false", "words\n")], RUN);
    await MetadataRepository.set(chatId(ID_A), { description: "Written in the app" });

    await importFragments([withId("", "more words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      description: "Written in the app",
      source: "manual",
    });
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("keeps a record the person retitled, when the file stops saying generate: false", async () => {
    await importFragments([withId("title: Old\ngenerate: false", "words\n")], RUN);
    await MetadataRepository.set(chatId(ID_A), { title: "Retitled in the app" });

    await importFragments([withId("", "more words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      title: "Retitled in the app",
      source: "manual",
    });
  });

  it("does not take away a record a file never made exempt: a title the file used to give stays when the file drops it", async () => {
    await importFragments([withId("title: Was given", "words\n")], RUN);

    await importFragments([withId("", "more words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      title: "Was given",
      source: "manual",
    });
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("does not hand a chat back to generation while its file still says generate: false", async () => {
    await importFragments([withId("generate: false", "words\n")], RUN);

    await importFragments([withId("generate: false", "more words\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({ source: "manual" });
    expect(await getDB().metadataQueue.count()).toBe(0);
  });

  it("writes the fields a changed file gives over the record, and leaves the others", async () => {
    await importFragments([withId("", "text one\n")], RUN);
    // what generation made of it, and what the person edited in the app since
    await MetadataRepository.set(chatId(ID_A), {
      title: "Generated",
      description: "Generated description",
      keywords: ["kept"],
      source: "ai",
    });

    await importFragments([withId("description: Given by the file", "text two\n")], RUN);

    expect(await MetadataRepository.get(chatId(ID_A))).toMatchObject({
      title: "Generated",
      description: "Given by the file",
      keywords: ["kept"],
      source: "manual",
    });
  });

  it("does not touch a record the person edited when the file is unchanged", async () => {
    const file = withId("title: From the file", "text\n");
    await importFragments([file], RUN);
    await MetadataRepository.set(chatId(ID_A), { title: "Edited in the app", source: "manual" });

    await importFragments([file], RUN);

    expect((await MetadataRepository.get(chatId(ID_A)))?.title).toBe("Edited in the app");
  });

  it("does not write metadata for a changed file when it is not allowed to overwrite", async () => {
    await importFragments([withId("", "text one\n")], RUN);
    await importFragments([withId("description: Given", "text two\n")], {
      ...RUN,
      overwrite: false,
    });

    expect((await MetadataRepository.get(chatId(ID_A)))?.description ?? "").toBe("");
  });
});

describe("a fragment in the archive", () => {
  it("is listed under the Modified Time sort, a dated one first and an undated one last", async () => {
    await importFragments(
      [
        withId("", "undated\n", ID_A, "undated.md"),
        withId("date: 2024-03", "dated\n", ID_B, "dated.md"),
        withId("date: ~2020", "older\n", ID_C, "older.md"),
      ],
      RUN,
    );

    const { metadata: chats, total } = await SyncService.getChatsMetadata(
      0,
      10,
      "all",
      "providerLastModifiedTimestamp",
      "desc",
    );

    expect(total).toBe(3);
    expect(chats.map((c) => c.id)).toEqual([chatId(ID_B), chatId(ID_C), chatId(ID_A)]);
    // the list carries what the archive reads the rough date from
    expect(roughDateOf(chats[0])).toMatchObject({ precision: "month" });
    expect(roughDateOf(chats[2])).toMatchObject({ precision: "unknown" });
  });

  it("lists twelve turns as written, in the viewer's order and in the Markdown export's", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `## User\nturn ${i + 1}\n`).join("\n");
    await importFragments([withId("date: 2024-03-15", body)], RUN);

    const branch = await SyncService.getPrimaryBranchMessages(chatId(ID_A));
    expect(branch.map((m) => m.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `t${String(i + 1).padStart(4, "0")}`),
    );

    const chat = await fullChat(ID_A);
    const exported = (c: Chat) =>
      generateExportContent(c, { format: "markdown", includeTimestamps: false });
    const turnsIn = (text: string) => [...text.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
    const expected = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(turnsIn(await exported(chat))).toEqual(expected);

    // with no links between the messages the exporter sorts by time: ids and equal times must not fool it
    const unlinked = {
      ...chat,
      messages: Object.fromEntries(
        Object.entries(chat.messages).map(([id, m]) => [
          id,
          { ...m, parentId: undefined, childrenIds: [] },
        ]),
      ),
    };
    expect(turnsIn(await exported(unlinked))).toEqual(expected);
  });

  it("is found by a word of a turn, its provider, a date around its middle, model: and tag:", async () => {
    await importFragments(
      [
        withId(
          "title: Lighthouse\nmodel: claude-3-opus\ndate: 2024-03\nplatform: poe\ntags: [poem]\ncollection: Conversations with a ghost",
          "## User\nTell me about the pineapple keeper.\n",
          ID_A,
          "dated.md",
        ),
        withId("", "an undated pineapple\n", ID_B, "undated.md"),
      ],
      RUN,
    );
    const chats = await Promise.all([ID_A, ID_B].map(fullChat));

    kitReset();
    const index = sqliteKit.create();
    await index.open();
    const build = index.beginRebuild();
    build.transaction(() => {
      for (const chat of chats) {
        const indexed = extractIndexedChat(chat);
        if (indexed) build.put(indexed);
      }
    });
    build.commit();
    try {
      const ids = (query: string, filters = {}) =>
        index
          .search(buildQueryPlan(parseSearchQuery(query)), filters)
          .map((r) => r.chatId)
          .sort();
      const dated = [chatId(ID_A)];
      const middle = chats[0].timestamp;

      expect(ids("pineapple")).toEqual([chatId(ID_A), chatId(ID_B)].sort());
      expect(ids("pineapple", { provider: "fragment" })).toHaveLength(2);
      expect(ids("pineapple", { after: middle - 1000, before: middle + 1000 })).toEqual(dated);
      // an undated fragment is outside every search that has an `after` bound
      expect(ids("pineapple", { after: 1 })).toEqual(dated);
      expect(ids("model:claude-3-opus")).toEqual(dated);
      expect(ids("tag:poem")).toEqual(dated);
      expect(ids("tag:poe")).toEqual(dated);
      expect(ids('tag:"conversations with a ghost"')).toEqual(dated);
      expect(ids("tag:ghost")).toEqual(dated);
      // the same words typed plain are not a label
      expect(ids("poe")).toEqual([]);
      expect(ids("claude")).toEqual([]);
      expect(ids("ghost")).toEqual([]);
    } finally {
      index.close();
    }
  });
});

function kitReset(): void {
  sqliteKit.reset();
}

describe("every reader copes with a fragment that names no model", () => {
  it("has no model in the index and no model on the Pi session export", async () => {
    const file: FragmentFile = withId("", "## User\nhi\n## Assistant\nho\n");
    await importFragments([file], RUN);
    const chat = await fullChat(ID_A);

    expect(chat.models).toEqual([]);
    expect(Object.values(chat.messages).map((m) => m.model)).toEqual(["", ""]);
    expect(extractIndexedChat(chat)?.messages.map((m) => m.model)).toEqual([undefined, undefined]);

    const { exportChatAsPiSessionJsonl } = await import("../src/background/export/piSessionExport");
    expect(() => exportChatAsPiSessionJsonl(chat)).not.toThrow();
  });

  it("keeps its fragment params through the store", async () => {
    await importFragments([withId("platform: poe", "words\n", ID_A, "/some/dir/words.md")], RUN);
    const params = (await SyncService.getChat(chatId(ID_A)))?.params.fragment as FragmentParams;
    expect(params).toMatchObject({ fileName: "words.md", platform: "poe", unattributed: [0] });
  });
});
