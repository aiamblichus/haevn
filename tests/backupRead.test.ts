import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import {
  backupSummary,
  chatRecordBlob,
  listBackupChats,
  mediaFile,
} from "../src/services/backup/backupRead";
import { BackupError } from "../src/services/backup/format";
import { isHeldForMove } from "../src/services/chatPersistence";
import type { ChatEmbeddingRecord, ChatMetadataRecord } from "../src/services/db";
import { getDB } from "../src/services/db";
import { FakeOpfs } from "./helpers/fakeOpfs";

// HVN-134 slice 2: the backup service's read side. Each rule below has a test that fails when the
// rule is taken out (the soft-delete filter, the key cursor).

let fs: FakeOpfs;

function chatRow(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    source: "claude",
    sourceId: id,
    title: `Chat ${id}`,
    models: [],
    params: {},
    currentId: "",
    messages: {},
    tags: [],
    timestamp: 1,
    lastSyncedTimestamp: 1,
    checksum: `sum-${id}`,
    syncStatus: "synced",
    deleted: 0,
    ...extra,
  };
}

function message(chatId: string, id: string): ChatMessage {
  return {
    id,
    childrenIds: [],
    message: [
      {
        kind: "response",
        timestamp: "2026-01-01T00:00:00.000Z",
        parts: [{ part_kind: "text", content: `text of ${id}` }],
      },
    ],
    model: "m",
    done: true,
    chatId,
    timestamp: 1,
  };
}

function metadataOf(chatId: string): ChatMetadataRecord {
  return {
    chatId,
    title: "Title",
    description: "Description",
    synopsis: "Synopsis",
    categories: ["work"],
    keywords: ["alpha", "beta"],
    source: "manual",
    updatedAt: 5,
  };
}

function embeddingOf(chatId: string): ChatEmbeddingRecord {
  return {
    chatId,
    vector: [0.5, -0.25, 0],
    vectorDim: 3,
    model: "embed-model",
    endpointHash: "endpoint",
    inputFingerprint: "input",
    updatedAt: 6,
  };
}

async function seedChat(
  row: Chat,
  options: { messages?: ChatMessage[]; metadata?: boolean; embedding?: boolean } = {},
): Promise<void> {
  const db = getDB();
  await db.chats.put(row);
  if (options.messages?.length) await db.chatMessages.bulkPut(options.messages);
  if (options.metadata) await db.chatMetadata.put(metadataOf(row.id as string));
  if (options.embedding) await db.chatEmbeddings.put(embeddingOf(row.id as string));
}

/** The lines of a chat's record, each parsed; the record must end with a newline. */
async function recordLines(chatId: string): Promise<Record<string, unknown>[]> {
  const text = await (await chatRecordBlob(chatId)).text();
  expect(text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function allIds(limit = 100): Promise<string[]> {
  return (await listBackupChats({ limit })).chats.map((chat) => chat.id);
}

beforeEach(async () => {
  fs = new FakeOpfs();
  fs.install();
  const db = getDB();
  await Promise.all([
    db.chats.clear(),
    db.chatMessages.clear(),
    db.chatMetadata.clear(),
    db.chatEmbeddings.clear(),
  ]);
});

describe("a chat's record", () => {
  it("its lines parse back to the stored chat row, message rows, metadata and embedding", async () => {
    const row = chatRow("c1");
    const messages = [message("c1", "m2"), message("c1", "m1"), message("c1", "m3")];
    await seedChat(row, { messages, metadata: true, embedding: true });

    const lines = await recordLines("c1");

    // Line 1 is the header; the messages follow in key order (m1, m2, m3) whatever order they were
    // written in.
    expect(lines[0]).toEqual({
      v: 1,
      chat: row,
      metadata: metadataOf("c1"),
      embedding: embeddingOf("c1"),
    });
    expect(lines.slice(1)).toEqual([message("c1", "m1"), message("c1", "m2"), message("c1", "m3")]);
  });

  it("a chat held for the move keeps its messages inline in line 1", async () => {
    const inline = { m1: message("h1", "m1") };
    const held = chatRow("h1", { messages: inline });
    await seedChat(held);

    // The fixture is the layout before v17: the messages are in the row and in no chatMessages row.
    expect(isHeldForMove(await getDB().chats.get("h1"))).toBe(true);

    const lines = await recordLines("h1");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ v: 1, chat: held, metadata: null, embedding: null });
    expect((lines[0].chat as Chat).messages).toEqual(inline);
  });

  it("a soft-deleted chat has no record: NOT_FOUND", async () => {
    await seedChat(chatRow("c2", { deleted: 1, deletedAt: 9 }), {
      messages: [message("c2", "m1")],
    });

    await expect(chatRecordBlob("c2")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(chatRecordBlob("nobody")).rejects.toBeInstanceOf(BackupError);
  });
});

describe("the list of live chats", () => {
  it("lists live chats in key order, each with its source and its media folder's files", async () => {
    await seedChat(chatRow("c2", { source: "chatgpt" }));
    await seedChat(chatRow("c1", { source: "claude" }));
    fs.put("media/c1/m1_0.png", "abcd");
    fs.put("media/c1/m2_0.jpg", "xy");

    const page = await listBackupChats({ limit: 10 });

    expect(page.chats).toEqual([
      {
        id: "c1",
        source: "claude",
        media: [
          { name: "m1_0.png", bytes: 4 },
          { name: "m2_0.jpg", bytes: 2 },
        ],
      },
      { id: "c2", source: "chatgpt", media: [] },
    ]);
    expect(page.next).toBeUndefined();
  });

  it("a soft-deleted chat is not listed", async () => {
    await seedChat(chatRow("c1"));
    await seedChat(chatRow("c2", { deleted: 1, deletedAt: 9 }));

    expect(await allIds()).toEqual(["c1"]);
    expect((await backupSummary()).liveChats).toBe(1);
  });

  it("pages by key across a page boundary, and skips soft-deleted chats", async () => {
    for (const id of ["c1", "c2", "c4", "c5"]) await seedChat(chatRow(id));
    await seedChat(chatRow("c3", { deleted: 1, deletedAt: 9 }));

    const first = await listBackupChats({ limit: 2 });
    expect(first.chats.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(first.next).toBe("c2");

    const second = await listBackupChats({ limit: 2, after: first.next });
    expect(second.chats.map((c) => c.id)).toEqual(["c4", "c5"]);
    expect(second.next).toBeUndefined();
  });

  it("a chat synced between two pages shifts no row the next page returns", async () => {
    for (const id of ["c1", "c2", "c3", "c4", "c5"]) await seedChat(chatRow(id));

    const first = await listBackupChats({ limit: 2 });
    expect(first.chats.map((c) => c.id)).toEqual(["c1", "c2"]);

    // A chat that sorts before the cursor arrives between the pages: an offset would count it.
    await seedChat(chatRow("c0"));

    const second = await listBackupChats({ limit: 2, after: first.next });
    expect(second.chats.map((c) => c.id)).toEqual(["c3", "c4"]);
    const third = await listBackupChats({ limit: 2, after: second.next });
    expect(third.chats.map((c) => c.id)).toEqual(["c5"]);
    expect(third.next).toBeUndefined();
  });
});

describe("media files", () => {
  it("a chat whose id has a colon reads its files from the folder the media writer uses", async () => {
    await seedChat(chatRow("claude:abc"));
    fs.put("media/claude_abc/m1_0.png", "pixels");

    const listed = await listBackupChats({ limit: 10 });
    expect(listed.chats[0].media).toEqual([{ name: "m1_0.png", bytes: 6 }]);

    const file = await mediaFile("claude:abc", "m1_0.png");
    expect(file.size).toBe(6);
    expect(await file.text()).toBe("pixels");
  });

  it("a media name with a slash or '..' is refused before the file system is read", async () => {
    await seedChat(chatRow("c1"));
    fs.put("media/c1/m1_0.png", "inside");
    fs.put("media/secret.txt", "outside");

    for (const name of [
      "../secret.txt",
      "../../secret.txt",
      "a/b.png",
      "..",
      ".",
      "a\\b.png",
      "",
    ]) {
      await expect(mediaFile("c1", name)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("a media file that is not there is NOT_FOUND", async () => {
    await seedChat(chatRow("c1"));
    await expect(mediaFile("c1", "missing.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(mediaFile("nobody", "missing.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("the summary", () => {
  it("reports the protocol, the Dexie schema and the live count", async () => {
    await seedChat(chatRow("c1"));
    await seedChat(chatRow("c2", { deleted: 1, deletedAt: 9 }));

    expect(await backupSummary()).toEqual({
      protocol: 1,
      dbSchema: getDB().verno,
      liveChats: 1,
    });
  });
});
