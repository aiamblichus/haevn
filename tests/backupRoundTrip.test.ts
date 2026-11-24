import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// HVN-137: the contract check the bridge has never had. A backup is taken and put back through
// everything that is real on both sides: the CLI's own `runBackup` and `runRestore`, the CLI's real
// daemon (`startDaemon`), a real WebSocket and real HTTP between them, the extension's real bridge
// (`wsBridge`, which dials the daemon exactly as in Chrome), the real backup service and restore
// session on Dexie (fake-indexeddb) and OPFS (an in-memory file system). What is not real is only
// what is not part of the contract: the search index, thumbnails, the provider-count cache.
//
// It fails when either side changes the wire (an action name or a field) or the format (the record
// version, the record's lines) alone, because the other side is the real other side.

const settings = vi.hoisted(() => ({ port: 0, apiKey: "round-trip-key", enabled: true }));
const spies = vi.hoisted(() => ({
  addOrUpdateChatInIndex: vi.fn(async (_id: string) => {}),
  rebuildIndex: vi.fn(async () => {}),
  recalculateProviderStats: vi.fn(async (_provider: string) => 0),
}));

vi.mock("../src/services/settingsService", () => ({
  getCliSettings: vi.fn(async () => ({ ...settings })),
  getMetadataAIConfig: vi.fn(),
  getStarmapConfig: vi.fn(),
}));
vi.mock("../src/services/syncService", () => ({
  SyncService: {
    addOrUpdateChatInIndex: spies.addOrUpdateChatInIndex,
    rebuildIndex: spies.rebuildIndex,
  },
}));
vi.mock("../src/services/cacheService", () => ({
  CacheService: { recalculateProviderStats: spies.recalculateProviderStats },
}));
vi.mock("../src/background/handlers/galleryHandlers", () => ({
  handleGenerateThumbnails: vi.fn(async () => {}),
}));
vi.mock("../src/background/utils/chatSyncUtils", () => ({ broadcastChatSynced: vi.fn() }));
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { runBackup } from "../cli/src/backup/engine";
import { type RestoreResult, runRestore } from "../cli/src/backup/restoreEngine";
import { startDaemon } from "../cli/src/daemon/server";
import { EXIT_DEFER, EXIT_FAILED, ExitError } from "../cli/src/utils/exit";
import { setActiveOperation } from "../src/background/state";
import { applyWsBridgeSettings, resetWsBridge } from "../src/background/wsBridge";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import type { ChatEmbeddingRecord, ChatMetadataRecord } from "../src/services/db";
import { getDB } from "../src/services/db";
import { mediaFolderName } from "../src/services/mediaStorage";
import { FakeOpfs } from "./helpers/fakeOpfs";

// ─── The archive ──────────────────────────────────────────────────────────────

let opfs: FakeOpfs;

function chatRow(id: string, extra: Partial<Chat> = {}): Chat {
  return {
    id,
    source: id.split(":")[0] || "claude",
    sourceId: `src-${id}`,
    title: `Chat ${id}`,
    models: ["m"],
    params: {},
    currentId: "m1",
    messages: {},
    tags: [],
    timestamp: 1,
    lastSyncedTimestamp: 1_000,
    providerLastModifiedTimestamp: 900,
    checksum: `sum-${id}`,
    syncStatus: "synced",
    deleted: 0,
    ...extra,
  };
}

function message(chatId: string, id: string, text: string): ChatMessage {
  return {
    id,
    childrenIds: [],
    message: [
      {
        kind: "response",
        timestamp: "2026-01-01T00:00:00.000Z",
        parts: [{ part_kind: "text", content: text }],
      },
    ],
    model: "m",
    done: true,
    chatId,
    timestamp: 1,
  };
}

function metadataOf(chatId: string, title = "A title"): ChatMetadataRecord {
  return {
    chatId,
    title,
    description: "Description ünï 日本語",
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

async function putChat(
  row: Chat,
  messages: ChatMessage[],
  options: { metadata?: ChatMetadataRecord; embedding?: boolean } = {},
): Promise<void> {
  const db = getDB();
  await db.chats.put(row);
  await db.chatMessages.bulkPut(messages);
  if (options.metadata) await db.chatMetadata.put(options.metadata);
  if (options.embedding) await db.chatEmbeddings.put(embeddingOf(row.id as string));
}

function putMedia(chatId: string, name: string, data: Uint8Array | string): void {
  opfs.put(`media/${mediaFolderName(chatId)}/${name}`, data);
}

const NON_LATIN_ID = "claude:ünï-日本語";
const NON_LATIN_NAME = "café_日本語_😀.png";
const SOFT_DELETED = "claude:soft-deleted";

/** Four live chats of every awkward kind, and one soft-deleted one that no backup holds. */
async function seedArchive(): Promise<void> {
  await putChat(
    chatRow("claude:one", { title: "Refusals as character", lastSyncedTimestamp: 1_111 }),
    [
      message("claude:one", "m1", "hello"),
      message("claude:one", "m2", "ünï 日本語 😀"),
      message("claude:one", "m3", "bye"),
    ],
    { metadata: metadataOf("claude:one"), embedding: true },
  );
  putMedia("claude:one", "m1_0.png", randomBytes(70_000));
  putMedia("claude:one", NON_LATIN_NAME, randomBytes(10));
  putMedia("claude:one", "empty.bin", new Uint8Array(0));

  await putChat(chatRow("chatgpt:two", { lastSyncedTimestamp: 2_222 }), [
    message("chatgpt:two", "m1", "two"),
  ]);

  await putChat(
    chatRow(NON_LATIN_ID, { title: "ünï 日本語", lastSyncedTimestamp: 3_333 }),
    [message(NON_LATIN_ID, "m1", "non-latin")],
    { metadata: metadataOf(NON_LATIN_ID, "Une idée") },
  );

  // a message row over a megabyte, and a media file that crosses many chunks
  await putChat(chatRow("gemini:big", { lastSyncedTimestamp: 4_444 }), [
    message("gemini:big", "m1", "x".repeat(1_500_000)),
  ]);
  putMedia("gemini:big", "big.bin", randomBytes(3 * 1024 * 1024));

  await putChat(chatRow(SOFT_DELETED, { deleted: 1, deletedAt: 9 }), [
    message(SOFT_DELETED, "m1", "deleted"),
  ]);
  putMedia(SOFT_DELETED, "gone.png", "gone");
}

const BACKED_UP = ["claude:one", "chatgpt:two", NON_LATIN_ID, "gemini:big"];

// ─── Dumps ────────────────────────────────────────────────────────────────────

interface Dump {
  tables: Record<string, unknown[]>;
  /** Path to size and SHA-256. */
  files: Record<string, string>;
}

async function readFile(path: string): Promise<Uint8Array> {
  let dir = await navigator.storage.getDirectory();
  const segments = path.split("/");
  const name = segments.pop() as string;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment);
  return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer());
}

/** Every table and every OPFS file, as plain data that two archives can be compared on. */
async function dump(): Promise<Dump> {
  const tables: Record<string, unknown[]> = {};
  for (const table of getDB().tables) tables[table.name] = await table.toArray();
  const files: Record<string, string> = {};
  for (const file of opfs.files()) {
    const bytes = await readFile(file);
    files[file] = `${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  return { tables, files };
}

/** What a dump holds of the chats `ids` (rows keyed by them, and the files in their media folders). */
function ofChats(d: Dump, ids: string[]): Dump {
  const gone = new Set(ids);
  const folders = new Set(ids.map((id) => `media/${mediaFolderName(id)}/`));
  const keyOf = (name: string, row: Record<string, unknown>): unknown =>
    name === "chats" ? row.id : row.chatId;
  const keyed = ["chats", "chatMessages", "chatMetadata", "chatEmbeddings"];
  const tables: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(d.tables)) {
    tables[name] = keyed.includes(name)
      ? rows.filter((row) => gone.has(keyOf(name, row as Record<string, unknown>) as string))
      : [];
  }
  const files = Object.fromEntries(
    Object.entries(d.files).filter(([file]) =>
      [...folders].some((folder) => file.startsWith(folder)),
    ),
  );
  return { tables, files };
}

/** What a dump holds of everything but the chats `ids`. */
function exceptChats(d: Dump, ids: string[]): Dump {
  const gone = new Set(ids);
  const folders = new Set(ids.map((id) => `media/${mediaFolderName(id)}/`));
  const keyOf = (name: string, row: Record<string, unknown>): unknown =>
    name === "chats" ? row.id : row.chatId;
  const keyed = ["chats", "chatMessages", "chatMetadata", "chatEmbeddings"];
  const tables: Record<string, unknown[]> = {};
  for (const [name, rows] of Object.entries(d.tables)) {
    tables[name] = keyed.includes(name)
      ? rows.filter((row) => !gone.has(keyOf(name, row as Record<string, unknown>) as string))
      : rows;
  }
  const files = Object.fromEntries(
    Object.entries(d.files).filter(
      ([file]) => ![...folders].some((folder) => file.startsWith(folder)),
    ),
  );
  return { tables, files };
}

async function wipe(): Promise<void> {
  await Promise.all(getDB().tables.map((table) => table.clear()));
  opfs = new FakeOpfs();
  opfs.install();
}

// ─── The wire, for real ───────────────────────────────────────────────────────

const KEY = settings.apiKey;
let root: string;
let daemon: { port: number; stop: () => Promise<void> } | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** A daemon of the CLI's own, and the extension's bridge connected to it. */
async function connect(): Promise<number> {
  const port = await freePort();
  settings.port = port;
  daemon = await startDaemon({ port, apiKey: KEY });
  await resetWsBridge();
  await vi.waitFor(
    async () => {
      const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
        extensionConnected: boolean;
      };
      expect(health.extensionConnected).toBe(true);
    },
    { timeout: 10_000, interval: 25 },
  );
  return port;
}

beforeAll(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-roundtrip-"));
  settings.enabled = true;
  spies.addOrUpdateChatInIndex.mockClear();
  spies.rebuildIndex.mockClear();
  spies.recalculateProviderStats.mockClear();
  vi.stubGlobal("chrome", {
    alarms: { create: vi.fn(), clear: vi.fn(async () => true) },
    storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
    runtime: { getManifest: () => ({ version: "9.9.9-roundtrip" }), sendMessage: async () => {} },
  });
  opfs = new FakeOpfs();
  opfs.install();
  await Promise.all(getDB().tables.map((table) => table.clear()));
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  // Switch the bridge off, so its alarm, its pings and its reconnect timer are gone
  settings.enabled = false;
  await applyWsBridgeSettings();
  vi.restoreAllMocks();
});

async function backUp(port: number, dir = path.join(root, "backup")): Promise<string> {
  await runBackup({
    dir,
    endpoint: { port, apiKey: KEY },
    waitMs: 10_000,
    timing: { pollMs: 25, retryDelaysMs: [5, 5], pageSize: 2 },
  });
  return dir;
}

function restoreFrom(
  port: number,
  dir: string,
  options: Partial<Parameters<typeof runRestore>[0]> = {},
): Promise<RestoreResult> {
  return runRestore({
    dir,
    endpoint: { port, apiKey: KEY },
    waitMs: 10_000,
    timing: { pollMs: 25, retryDelaysMs: [5, 5], pageSize: 2 },
    ...options,
  });
}

// ─── The round trip ───────────────────────────────────────────────────────────

describe("backup, then restore, through the real daemon and the real bridge", () => {
  it("brings an emptied archive back exactly as it was: every row, every file, byte for byte", async () => {
    await seedArchive();
    const before = await dump();
    const port = await connect();
    const dir = await backUp(port);

    await wipe();
    const result = await restoreFrom(port, dir);

    // Everything but the chat that was deleted when the backup was taken
    expect(await dump()).toEqual(exceptChats(before, [SOFT_DELETED]));
    expect(result).toMatchObject({ replaced: 0, added: 4, mediaFiles: 4 });
    // The restored chats are in the search index one by one, and the provider counts are recalculated
    expect(spies.addOrUpdateChatInIndex.mock.calls.map(([id]) => id).sort()).toEqual(
      [...BACKED_UP].sort(),
    );
    expect(spies.rebuildIndex).not.toHaveBeenCalled();
    expect(spies.recalculateProviderStats.mock.calls.map(([p]) => p).sort()).toEqual([
      "chatgpt",
      "claude",
      "gemini",
    ]);
  }, 60_000);

  it("keeps the three rules in an archive that moved on: replaces by id, adds what is missing, touches nothing else", async () => {
    await seedArchive();
    const original = await dump();
    const port = await connect();
    const dir = await backUp(port);

    // Tuesday's backup; then the archive moves on
    //  - claude:one changes: other messages, another title and metadata, a new sync time, a media file gone and a stray one added
    const db = getDB();
    await db.chats.update("claude:one", { title: "Retitled", lastSyncedTimestamp: 7_777 });
    await db.chatMessages.where("chatId").equals("claude:one").delete();
    await db.chatMessages.put(message("claude:one", "m9", "written after the backup"));
    await db.chatMetadata.put(metadataOf("claude:one", "New AI title"));
    opfs.put(`media/${mediaFolderName("claude:one")}/orphan.png`, "stray");
    await db.chatEmbeddings.delete("claude:one");
    //  - chatgpt:two is deleted for good, rows and media
    await db.chats.delete("chatgpt:two");
    await db.chatMessages.where("chatId").equals("chatgpt:two").delete();
    //  - the non-Latin chat is soft-deleted
    await db.chats.update(NON_LATIN_ID, { deleted: 1, deletedAt: 5 });
    //  - a chat the backup never saw, with media, and a row of a table the backup does not hold
    await putChat(chatRow("claude:bystander", { lastSyncedTimestamp: 9_999 }), [
      message("claude:bystander", "m1", "mine"),
    ]);
    putMedia("claude:bystander", "keep.png", "keep me");
    await db.cache.put({ id: "provider-count:claude", value: 41, timestamp: 1 } as never);
    const moved = await dump();

    // A dry run says what a restore would do, and does it to nothing
    const dry = await restoreFrom(port, dir, { dryRun: true });
    expect(dry.plan).toMatchObject({ chats: 4, replaced: 2, changed: 1, added: 2 });
    expect(await dump()).toEqual(moved);

    const result = await restoreFrom(port, dir);

    const after = await dump();
    // Rule 1 and 2: each chat of the backup is as it was, including the deleted ones that came back
    expect(ofChats(after, BACKED_UP).tables).toEqual(ofChats(original, BACKED_UP).tables);
    const restoredFiles = Object.keys(ofChats(original, BACKED_UP).files);
    for (const file of restoredFiles) {
      expect(after.files[file]).toBe(original.files[file]);
    }
    // Rule 3: all else is as it was before the restore (the one file restore leaves is the stray)
    expect(exceptChats(after, BACKED_UP)).toEqual(exceptChats(moved, BACKED_UP));
    expect(after.files[`media/${mediaFolderName("claude:one")}/orphan.png`]).toBe(
      moved.files[`media/${mediaFolderName("claude:one")}/orphan.png`],
    );
    expect(after.files[`media/${mediaFolderName("claude:bystander")}/keep.png`]).toBeDefined();
    // the soft-deleted chat is a row that exists, and still an addition: it was not live
    expect(result).toMatchObject({ replaced: 2, added: 2 });
    // the chat soft-deleted since is live again
    expect((await db.chats.get(NON_LATIN_ID))?.deleted).toBe(0);
    expect((await db.chats.get(NON_LATIN_ID))?.deletedAt).toBeUndefined();
  }, 60_000);

  it("restores one chat with --chat and leaves the others as they are", async () => {
    await seedArchive();
    const port = await connect();
    const dir = await backUp(port);
    const db = getDB();
    await db.chats.update("claude:one", { title: "Retitled" });
    await db.chats.update("chatgpt:two", { title: "Also retitled" });
    const moved = await dump();

    const result = await restoreFrom(port, dir, { chatIds: ["claude:one"] });

    expect(result).toMatchObject({ replaced: 1, added: 0, mediaFiles: 3 });
    expect((await db.chats.get("claude:one"))?.title).toBe("Refusals as character");
    expect((await db.chats.get("chatgpt:two"))?.title).toBe("Also retitled");
    expect(exceptChats(await dump(), ["claude:one"])).toEqual(exceptChats(moved, ["claude:one"]));
  }, 60_000);

  it("a big restore is indexed once at the end, as the extension decides", async () => {
    for (let n = 0; n < 22; n++) {
      const id = `claude:small-${String(n).padStart(2, "0")}`;
      await putChat(chatRow(id), [message(id, "m1", `chat ${n}`)]);
    }
    const before = await dump();
    const port = await connect();
    const dir = await backUp(port);
    await wipe();

    await restoreFrom(port, dir);

    expect(await dump()).toEqual(before);
    expect(spies.addOrUpdateChatInIndex).not.toHaveBeenCalled();
    expect(spies.rebuildIndex).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("gives the lock back: a second restore right after the first finds the extension free", async () => {
    await seedArchive();
    const port = await connect();
    const dir = await backUp(port);

    await restoreFrom(port, dir, { chatIds: ["chatgpt:two"] });
    const second = await restoreFrom(port, dir, { chatIds: ["chatgpt:two"] });

    expect(second).toMatchObject({ replaced: 1, added: 0 });
  }, 60_000);

  // The other half of the wire: what the extension answers when a restore cannot start or cannot
  // finish cleanly. A rename of the code (BUSY) or the field (indexError) on one side must show here.

  it("defers (75) when another operation holds the extension, and writes nothing", async () => {
    await seedArchive();
    const port = await connect();
    const dir = await backUp(port);
    await wipe();
    await setActiveOperation("bulkSync");

    const err = await restoreFrom(port, dir).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).exitCode).toBe(EXIT_DEFER);
    expect((err as ExitError).message).toMatch(/bulkSync/);
    expect(await getDB().chats.count()).toBe(0);
  }, 60_000);

  it("fails (1) when the index could not be brought up to date, with every chat in", async () => {
    await seedArchive();
    const before = await dump();
    const port = await connect();
    const dir = await backUp(port);
    await wipe();
    spies.addOrUpdateChatInIndex.mockRejectedValueOnce(new Error("the index worker is gone"));

    const err = await restoreFrom(port, dir).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(ExitError);
    expect((err as ExitError).exitCode).toBe(EXIT_FAILED);
    expect((err as ExitError).message).toContain("the index worker is gone");
    expect((err as ExitError).message).toMatch(/every chat is restored/);
    expect(await dump()).toEqual(exceptChats(before, [SOFT_DELETED]));
    // the lock is back, and the same command run again finishes
    expect(await restoreFrom(port, dir)).toMatchObject({ replaced: 4, added: 0 });
  }, 60_000);
});
