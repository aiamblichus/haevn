import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actionHeader } from "../daemon/client.js";
import {
  type FakeChat,
  FakeExtension,
  type FakeExtensionOptions,
  type Fault,
} from "../testing/fakeExtension.js";
import { ExitError } from "../utils/exit.js";
import { runBackup } from "./engine.js";
import type { IndexEntry } from "./layout.js";
import { type RestoreOptions, type RestoreResult, runRestore } from "./restoreEngine.js";

const KEY = "test-key";

let root: string;
const extensions: FakeExtension[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-restore-test-"));
  // The daemon logs its life to stderr; keep the test output readable.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  for (const extension of extensions.splice(0)) extension.stop();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

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

// ─── The backup the tests restore ─────────────────────────────────────────────

/** A chat record as the extension writes it: the header (with `v` first), then one message. */
function record(id: string, lastSyncedTimestamp: number, text = `hello from ${id}`): Buffer {
  return Buffer.from(
    `${JSON.stringify({ v: 1, chat: { id, lastSyncedTimestamp }, metadata: null, embedding: null })}\n` +
      `${JSON.stringify({ chatId: id, id: "m1", text })}\n`,
  );
}

const photo = randomBytes(5_000);
const NON_LATIN_ID = "chat/ünï-日本語";
const NON_LATIN_NAME = "café_日本語_😀.png";

/** What the backup holds: four chats, media of every awkward kind. */
function backedUp(): FakeChat[] {
  return [
    {
      id: "claude:a1",
      source: "claude",
      record: record("claude:a1", 1_000),
      media: [
        { name: "msg1_0.png", data: photo },
        { name: NON_LATIN_NAME, data: Buffer.from("non-latin") },
        { name: "empty.bin", data: Buffer.alloc(0) },
      ],
    },
    { id: NON_LATIN_ID, source: "claude", record: record(NON_LATIN_ID, 2_000) },
    { id: "claude:b2", source: "claude", record: record("claude:b2", 3_000) },
    {
      id: "gemini:c3",
      source: "gemini",
      record: record("gemini:c3", 4_000),
      media: [{ name: "big.bin", data: randomBytes(8 * 1024 * 1024) }],
    },
  ];
}

/** The archive being restored into: two chats of the backup (one changed since), and a bystander. */
function archiveNow(): FakeChat[] {
  return [
    { id: "claude:a1", source: "claude", lastSyncedTimestamp: 1_000 },
    { id: NON_LATIN_ID, source: "claude", lastSyncedTimestamp: 2_500 },
    { id: "claude:z9", source: "claude", lastSyncedTimestamp: 9_000 },
  ];
}

/** Back `chats` up with the real backup engine into a directory of its own. */
async function makeBackup(chats: FakeChat[], name = "backup"): Promise<string> {
  const port = await freePort();
  const extension = new FakeExtension(port, chats);
  extensions.push(extension);
  extension.start();
  const dir = path.join(root, name);
  await runBackup({
    dir,
    endpoint: { port, apiKey: KEY },
    waitMs: 5_000,
    timing: { pollMs: 20, retryDelaysMs: [5, 5] },
  });
  extension.stop();
  return dir;
}

interface Target {
  port: number;
  extension: FakeExtension;
}

async function target(
  chats: FakeChat[] = archiveNow(),
  options: FakeExtensionOptions = {},
  { start = true }: { start?: boolean } = {},
): Promise<Target> {
  const port = await freePort();
  const extension = new FakeExtension(port, chats, options);
  extensions.push(extension);
  if (start) extension.start();
  return { port, extension };
}

function restore(
  dir: string,
  t: Target,
  options: Partial<RestoreOptions> = {},
): Promise<RestoreResult> {
  return runRestore({
    dir,
    endpoint: { port: t.port, apiKey: KEY },
    waitMs: 5_000,
    timing: { pollMs: 20, retryDelaysMs: [5, 5], pageSize: 2 },
    ...options,
  });
}

async function endedAs(run: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ExitError) return { code: err.exitCode, message: err.message };
    throw err;
  }
  throw new Error("the restore finished; it was meant to end early");
}

/** The restore actions the extension was asked: none of them, when nothing was written. */
function restoreRequests(t: Target): string[] {
  return t.extension.asked.filter((label) => label.startsWith("restore"));
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readIndex(dir: string): IndexEntry[] {
  return fs
    .readFileSync(path.join(dir, "index.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IndexEntry);
}

/** Rewrite a file of the backup and fix nothing else: the index and manifest stay as they were. */
function tamper(dir: string, relative: string, change: (bytes: Buffer) => Buffer): void {
  const file = path.join(dir, relative);
  fs.writeFileSync(file, change(fs.readFileSync(file)));
}

function editManifest(dir: string, change: (manifest: Record<string, unknown>) => void): void {
  const file = path.join(dir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  change(manifest);
  fs.writeFileSync(file, JSON.stringify(manifest));
}

// ─── The header ───────────────────────────────────────────────────────────────

describe("the X-Haevn-Request header", () => {
  it("is ASCII only, and reads back as the same action", () => {
    const action = {
      action: "restoreMedia",
      chatId: NON_LATIN_ID,
      name: `${NON_LATIN_NAME}\u007f\u0001`,
      bytes: 3,
    };

    const header = actionHeader(action);

    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(header).toContain("\\u00fc"); // ü, escaped
    expect(JSON.parse(header)).toEqual(action);
  });

  it("keeps a backslash and a quote of the action as they were", () => {
    const action = { action: "restoreChat", chatId: 'a\\"b' };

    expect(JSON.parse(actionHeader(action))).toEqual(action);
  });
});

// ─── 0: done ──────────────────────────────────────────────────────────────────

describe("haevn restore, a run that finishes (exit 0)", () => {
  it("sends each chat's media first and then its record, byte for byte, and tells which it replaced", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    const result = await restore(dir, t);

    const events = t.extension.restoreEvents;
    expect(events[0]).toEqual({ kind: "begin", chats: 4 });
    expect(events[events.length - 1]).toEqual({ kind: "finish", rebuildIndex: false });
    // media before the record, chat by chat, in the backup's order
    const flow = events
      .slice(1, -1)
      .map((e) =>
        e.kind === "media" ? `m:${e.chatId}/${e.name}` : `c:${(e as { chatId: string }).chatId}`,
      );
    const order = readIndex(dir).map((entry) => entry.id);
    const chatsInOrder = flow.filter((x) => x.startsWith("c:")).map((x) => x.slice(2));
    expect(chatsInOrder).toEqual(order);
    for (const entry of readIndex(dir)) {
      const at = flow.indexOf(`c:${entry.id}`);
      for (const media of entry.media) {
        expect(flow.indexOf(`m:${entry.id}/${media.name}`)).toBeLessThan(at);
      }
    }
    // the bytes are the backup's
    for (const entry of readIndex(dir)) {
      expect(t.extension.receivedRecords.get(entry.id)).toEqual(
        fs.readFileSync(path.join(dir, entry.file)),
      );
      for (const media of entry.media) {
        const received = t.extension.receivedMedia.get(`${entry.id}/${media.name}`);
        expect(received?.length).toBe(media.bytes);
        expect(sha(received as Buffer)).toBe(media.sha256);
      }
    }
    expect(result).toMatchObject({ dryRun: false, replaced: 2, added: 2, mediaFiles: 4 });
    expect(result.bytes).toBeGreaterThan(8 * 1024 * 1024);
  });

  it("carries a chat id, a media name and a zero-length file that are not ASCII through the header intact", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    await restore(dir, t);

    expect(t.extension.receivedMedia.get(`claude:a1/${NON_LATIN_NAME}`)?.toString()).toBe(
      "non-latin",
    );
    expect(t.extension.receivedMedia.get("claude:a1/empty.bin")?.length).toBe(0);
    expect(t.extension.receivedRecords.get(NON_LATIN_ID)?.toString()).toContain(NON_LATIN_ID);
  });

  it("indexes each chat as it is saved when the extension says so, and asks for no rebuild", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { restore: { indexPerChat: true } });

    await restore(dir, t);

    const chats = t.extension.restoreEvents.filter((e) => e.kind === "chat");
    expect(chats).toHaveLength(4);
    expect(chats.every((e) => e.kind === "chat" && e.index)).toBe(true);
    expect(t.extension.restoreEvents.at(-1)).toEqual({ kind: "finish", rebuildIndex: false });
  });

  it("indexes once at the end when the extension says so: no chat asks for it, the finish does", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { restore: { indexPerChat: false } });

    await restore(dir, t);

    const chats = t.extension.restoreEvents.filter((e) => e.kind === "chat");
    expect(chats).toHaveLength(4);
    expect(chats.every((e) => e.kind === "chat" && !e.index)).toBe(true);
    expect(t.extension.restoreEvents.at(-1)).toEqual({ kind: "finish", rebuildIndex: true });
  });

  it("restores only the chats asked for with --chat, and their media", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    const result = await restore(dir, t, {
      chatIds: ["gemini:c3", "claude:b2", "claude:a1", "claude:a1"],
    });

    expect(t.extension.restoreEvents[0]).toEqual({ kind: "begin", chats: 3 });
    expect([...t.extension.receivedRecords.keys()].sort()).toEqual([
      "claude:a1",
      "claude:b2",
      "gemini:c3",
    ]);
    expect(t.extension.receivedMedia.size).toBe(4);
    expect(result.plan).toMatchObject({ chats: 3, backupChats: 4, replaced: 1, added: 2 });
    // the extension's own word for each chat counts, and one is replaced, two are added
    expect(result).toMatchObject({ replaced: 1, added: 2 });
  });

  it("counts a chat that is only a soft-deleted row as added, as the plan does", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { restore: { replacedAlways: true } });

    const result = await restore(dir, t);

    expect(result).toMatchObject({ replaced: 2, added: 2 });
  });

  it("uses a daemon that is already running, and leaves it running", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    // The first run's daemon belongs to it; a second command finds one standing and uses it.
    const { startDaemon } = await import("../daemon/server.js");
    const standing = await startDaemon({ port: t.port, apiKey: KEY });
    try {
      await restore(dir, t);
      const health = await fetch(`http://127.0.0.1:${t.port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await standing.stop();
    }
  });

  it("restores a backup with no chats by doing nothing", async () => {
    const dir = await makeBackup([]);
    const t = await target();

    const result = await restore(dir, t);

    expect(result.plan.chats).toBe(0);
    expect(restoreRequests(t)).toEqual([]);
  });
});

// ─── The plan, and the question ───────────────────────────────────────────────

describe("haevn restore, what it says before it writes", () => {
  it("counts the chats it would replace, the ones changed since, and the ones it would add", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    const result = await restore(dir, t, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.plan).toMatchObject({
      chats: 4,
      replaced: 2,
      changed: 1, // the non-Latin chat was synced at 2500 since the backup's 2000
      added: 2,
      mediaFiles: 4,
    });
    expect(result.plan.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(result.plan.haevnVersion).toBe("9.9.9-test");
  });

  it("writes nothing in a dry run: the extension is asked to list and to say its version, never to restore", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    await restore(dir, t, { dryRun: true, confirm: async () => false });

    expect(restoreRequests(t)).toEqual([]);
    expect(t.extension.receivedRecords.size).toBe(0);
  });

  it("does not say how many changed when the extension does not say when its chats were synced", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow().map(({ lastSyncedTimestamp: _drop, ...chat }) => chat));

    const result = await restore(dir, t, { dryRun: true });

    expect(result.plan.replaced).toBe(2);
    expect(result.plan.changed).toBeNull();
  });

  it("counts a chat it cannot compare as changed, not as untouched", async () => {
    const dir = await makeBackup(backedUp());
    const chats = archiveNow();
    chats[0].lastSyncedTimestamp = undefined; // this one has none; the others are listed with one
    const t = await target(chats);

    const result = await restore(dir, t, { dryRun: true });

    expect(result.plan.changed).toBe(2);
  });

  it("asks once, with the plan, before the first write", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    const asked = vi.fn(async () => true);

    await restore(dir, t, { confirm: asked });

    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0]).toEqual([
      expect.objectContaining({ chats: 4, replaced: 2, added: 2 }),
    ]);
  });

  it("is not confirmed: nothing is written, and it ends 1", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    const ended = await endedAs(restore(dir, t, { confirm: async () => false }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("nothing was written");
    expect(restoreRequests(t)).toEqual([]);
  });
});

// ─── A backup that is not whole: nothing is written ───────────────────────────

describe("haevn restore, a backup it will not use (exit 1, nothing written)", () => {
  it("a byte of a record that is not what the index says", async () => {
    const dir = await makeBackup(backedUp());
    const file = readIndex(dir)[0].file;
    tamper(dir, file, (bytes) => {
      const copy = Buffer.from(bytes);
      copy[copy.length - 3] ^= 0xff; // the same size, other bytes
      return copy;
    });
    const t = await target();

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("damaged");
    expect(ended.message).toContain(file);
    expect(ended.message).toContain("SHA-256");
    expect(restoreRequests(t)).toEqual([]);
  });

  it("a media file that is shorter than the index says", async () => {
    const dir = await makeBackup(backedUp());
    tamper(dir, "media/claude%3Aa1/msg1_0.png", (bytes) => bytes.subarray(0, 100));
    const t = await target();

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("msg1_0.png is 100 bytes");
    expect(restoreRequests(t)).toEqual([]);
  });

  it("a file that is gone, and every other problem in the same message", async () => {
    const dir = await makeBackup(backedUp());
    const [first, second] = readIndex(dir);
    fs.rmSync(path.join(dir, first.file));
    tamper(dir, second.file, (bytes) => Buffer.concat([bytes, Buffer.from("x")]));
    const t = await target();

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("2 files do not match");
    expect(ended.message).toContain(`${first.file} is missing`);
    expect(ended.message).toContain(second.file);
    expect(restoreRequests(t)).toEqual([]);
  });

  it("a record that does not start as a version 1 record", async () => {
    const dir = await makeBackup(backedUp());
    const entry = readIndex(dir)[0];
    const other = Buffer.from(
      fs.readFileSync(path.join(dir, entry.file)).toString().replace('{"v":1,', '{"v":2,'),
    );
    fs.writeFileSync(path.join(dir, entry.file), other);
    // keep the index honest about the new bytes: only the version is wrong
    const lines = readIndex(dir).map((e) =>
      e.id === entry.id ? { ...e, bytes: other.length, sha256: sha(other) } : e,
    );
    fs.writeFileSync(
      path.join(dir, "index.jsonl"),
      lines.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
    const t = await target();

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("is not a version 1 chat record");
    expect(restoreRequests(t)).toEqual([]);
  });

  it("a directory with no manifest (a backup that never finished)", async () => {
    const dir = await makeBackup(backedUp());
    fs.rmSync(path.join(dir, "manifest.json"));
    const t = await target();

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("no manifest.json");
    expect(t.extension.asked).toEqual([]); // it never even reached for the extension
  });

  it("a directory that is not there, and one that is a file", async () => {
    const t = await target();
    const file = path.join(root, "a-file");
    fs.writeFileSync(file, "x");

    expect((await endedAs(restore(path.join(root, "nope"), t))).message).toContain(
      "does not exist",
    );
    expect((await endedAs(restore(file, t))).message).toContain("is not a directory");
  });

  it("a manifest of another format, of a newer version, and of a version this CLI does not know", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    editManifest(dir, (m) => {
      m.format = "something-else";
    });
    expect((await endedAs(restore(dir, t))).message).toContain("not a haevn backup");

    editManifest(dir, (m) => {
      m.format = "haevn-backup";
      m.version = 2;
    });
    const newer = await endedAs(restore(dir, t));
    expect(newer.code).toBe(1);
    expect(newer.message).toContain("version 2");
    expect(newer.message).toContain("update the CLI");

    editManifest(dir, (m) => {
      m.version = 0;
    });
    expect((await endedAs(restore(dir, t))).code).toBe(1);
    expect(t.extension.asked).toEqual([]);
  });

  it("an index that disagrees with the manifest, lists a chat twice, or names a path outside the backup", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    const original = fs.readFileSync(path.join(dir, "index.jsonl"), "utf8");
    const lines = original.split("\n").filter(Boolean);

    fs.writeFileSync(path.join(dir, "index.jsonl"), `${lines.slice(1).join("\n")}\n`);
    expect((await endedAs(restore(dir, t))).message).toContain(
      "says 4 chats and index.jsonl lists 3",
    );

    fs.writeFileSync(
      path.join(dir, "index.jsonl"),
      `${[lines[0], lines[0], lines[2], lines[3]].join("\n")}\n`,
    );
    expect((await endedAs(restore(dir, t))).message).toContain("is listed twice");

    const escaping = { ...JSON.parse(lines[0]), file: "../outside.jsonl" };
    fs.writeFileSync(
      path.join(dir, "index.jsonl"),
      `${[JSON.stringify(escaping), ...lines.slice(1)].join("\n")}\n`,
    );
    expect((await endedAs(restore(dir, t))).message).toContain("leaves the backup");

    expect(t.extension.asked).toEqual([]);
  });

  it("a chat asked for with --chat that the backup does not hold", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();

    const ended = await endedAs(restore(dir, t, { chatIds: ["claude:b2", "nobody"] }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain('chat "nobody" is not in the backup');
    expect(t.extension.asked).toEqual([]);
  });

  it("an extension whose archive is older than the backup's", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { info: { dbSchema: 20 } });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("schema 20");
    expect(ended.message).toContain("schema 21");
    expect(restoreRequests(t)).toEqual([]);
  });

  it("an extension whose archive is newer than the backup's is fine", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { info: { dbSchema: 22 } });

    await restore(dir, t);

    expect(t.extension.receivedRecords.size).toBe(4);
  });

  it("an extension that speaks another protocol, or does not know the actions", async () => {
    const dir = await makeBackup(backedUp());

    const other = await target(archiveNow(), { info: { protocol: 2 } });
    expect((await endedAs(restore(dir, other))).message).toContain("protocol 2");

    const old = await target(archiveNow(), { info: "unknown-action" });
    expect((await endedAs(restore(dir, old))).message).toContain("update the extension");
    expect(restoreRequests(old)).toEqual([]);
  });

  it("a file that is not what the index says by the time it is sent", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    const confirm = async () => {
      // checked a minute ago; the person took their time, and the file changed under the run
      tamper(dir, "media/claude%3Aa1/msg1_0.png", (bytes) => Buffer.from(bytes).fill(7));
      return true;
    };

    const ended = await endedAs(restore(dir, t, { confirm }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("changed while it was being restored");
    expect(ended.message).toContain("Running the same command again finishes the restore");
  });

  it("a file that got shorter, or went, after it was checked: it ends at once, naming the file, and does not wait for the daemon's limit", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    const shorter = async () => {
      tamper(dir, "media/claude%3Aa1/msg1_0.png", (bytes) => bytes.subarray(0, 10));
      return true;
    };

    const short = await endedAs(restore(dir, t, { confirm: shorter }));

    expect(short.code).toBe(1);
    expect(short.message).toContain(
      "media/claude%3Aa1/msg1_0.png changed while it was being restored",
    );

    const second = await makeBackup(backedUp(), "second");
    const t2 = await target();
    const gone = async () => {
      fs.rmSync(path.join(second, "media/claude%3Aa1/msg1_0.png"));
      return true;
    };

    const missing = await endedAs(restore(second, t2, { confirm: gone }));

    expect(missing.code).toBe(1);
    expect(missing.message).toContain("media/claude%3Aa1/msg1_0.png could not be read");
    expect(t2.extension.restoreEvents.at(-1)).toMatchObject({ kind: "finish" });
  });

  it("an index that names a media file with a path in its name", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    const lines = readIndex(dir).map((entry) =>
      entry.media.length > 0
        ? {
            ...entry,
            media: [{ ...entry.media[0], name: "../../evil.png" }, ...entry.media.slice(1)],
          }
        : entry,
    );
    fs.writeFileSync(
      path.join(dir, "index.jsonl"),
      lines.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("is not a file name");
    expect(t.extension.asked).toEqual([]);
  });

  it("a manifest that counts other media files than the index lists", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target();
    editManifest(dir, (m) => {
      m.mediaFiles = 9;
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("says 9 media files and index.jsonl lists 4");
    expect(t.extension.asked).toEqual([]);
  });

  it("counts a chat whose record does not say when it was synced as changed", async () => {
    const chats = backedUp();
    chats[0].record = Buffer.from(
      `${JSON.stringify({ v: 1, chat: { id: "claude:a1" }, metadata: null, embedding: null })}\n`,
    );
    const dir = await makeBackup(chats);
    const t = await target();

    const result = await restore(dir, t, { dryRun: true });

    // a1 cannot be compared (counted), and the non-Latin chat changed since the backup
    expect(result.plan).toMatchObject({ replaced: 2, changed: 2 });
  });
});

// ─── 75: not now ──────────────────────────────────────────────────────────────

describe("haevn restore, not now (exit 75)", () => {
  it("nobody connects within --wait", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {}, { start: false });

    const ended = await endedAs(restore(dir, t, { waitMs: 150 }));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("no extension connected within");
  });

  it("the extension answers BUSY at restoreBegin: nothing was sent, and no 'run again' is promised", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreBegin"
          ? { error: "BUSY", message: "bulk sync is running" }
          : undefined,
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("busy");
    expect(ended.message).not.toContain("finishes the restore");
    expect(restoreRequests(t)).toEqual(["restoreBegin"]); // not tried again, and no finish
  });

  it("the connection is lost mid-run and does not return: 75, and the line says to run it again", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreChat" && frame.chatId === "claude:b2" ? { drop: true } : undefined,
    });

    const ended = await endedAs(restore(dir, t, { waitMs: 300 }));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("lost");
    expect(ended.message).toContain("Running the same command again finishes the restore");
  });

  it("every chat is in, but the connection is lost for the finish and does not return: the run is not done (75)", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreFinish" ? { drop: true } : undefined,
    });

    const ended = await endedAs(restore(dir, t, { waitMs: 300 }));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("lost");
    expect(ended.message).toContain("Running the same command again finishes the restore");
    expect(t.extension.receivedRecords.size).toBe(4);
  });

  it("the connection is lost and comes back within --wait: the chat is sent again and the run finishes", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame, n): Fault | undefined =>
        frame.action === "restoreChat" && frame.chatId === "claude:b2" && n === 1
          ? { drop: true, returnAfterMs: 150 }
          : undefined,
    });

    await restore(dir, t, { waitMs: 5_000 });

    expect(t.extension.asked.filter((q) => q === "restoreChat claude:b2")).toHaveLength(2);
    expect(t.extension.receivedRecords.size).toBe(4);
  });
});

// ─── 1: failed, after the restore began ───────────────────────────────────────

describe("haevn restore, a run that fails after it began (exit 1)", () => {
  it("tries a spent pipe id again, and finishes", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame, n): Fault | undefined =>
        frame.action === "restoreMedia" && frame.name === "msg1_0.png" && n === 1
          ? "spent"
          : undefined,
    });

    await restore(dir, t);

    expect(t.extension.asked.filter((q) => q.includes("msg1_0.png"))).toHaveLength(2);
    expect(t.extension.receivedMedia.get("claude:a1/msg1_0.png")).toEqual(photo);
  });

  it("gives up after three tries in all, says to run it again, and still closes the restore", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreChat" && frame.chatId === "claude:b2" ? "spent" : undefined,
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("chat claude:b2");
    expect(ended.message).toContain("3 tries");
    expect(ended.message).toContain("Running the same command again finishes the restore");
    expect(t.extension.asked.filter((q) => q === "restoreChat claude:b2")).toHaveLength(3);
    expect(t.extension.restoreEvents.at(-1)).toEqual({ kind: "finish", rebuildIndex: false });
  });

  it.each([
    "BAD_REQUEST",
    "NO_SESSION",
    "INTERNAL_ERROR",
  ])("%s from the extension is not tried again", async (code) => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreChat" && frame.chatId === "claude:b2"
          ? { error: code, message: "the extension said no" }
          : undefined,
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain(code);
    expect(ended.message).toContain("Running the same command again finishes the restore");
    expect(t.extension.asked.filter((q) => q === "restoreChat claude:b2")).toHaveLength(1);
  });

  it("a session the extension closed meanwhile ends the run at the next request, and finish does not hide it", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { restore: { sessionLost: true } });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("NO_SESSION");
    // the finish's own NO_SESSION was asked and ignored
    expect(restoreRequests(t).at(-1)).toBe("restoreFinish");
  });

  it("ignores NO_SESSION at the finish of a run that went well", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined =>
        frame.action === "restoreFinish" ? { error: "NO_SESSION" } : undefined,
    });

    const result = await restore(dir, t);

    expect(result.added).toBe(2);
  });

  it("closes the restore of a run that fails, and keeps the run's own error when the finish fails too", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      fault: (frame): Fault | undefined => {
        if (frame.action === "restoreChat" && frame.chatId === "claude:b2")
          return { error: "BAD_REQUEST", message: "no" };
        if (frame.action === "restoreFinish") return { error: "INTERNAL_ERROR", message: "boom" };
        return undefined;
      },
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("chat claude:b2");
    expect(ended.message).not.toContain("boom");
    expect(restoreRequests(t).at(-1)).toBe("restoreFinish");
  });

  it("asks for the index rebuild at the finish of a failed run too when the extension indexes at the end", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      restore: { indexPerChat: false },
      fault: (frame): Fault | undefined =>
        frame.action === "restoreChat" && frame.chatId === "claude:b2"
          ? { error: "BAD_REQUEST" }
          : undefined,
    });

    await endedAs(restore(dir, t));

    expect(t.extension.restoreEvents.at(-1)).toEqual({ kind: "finish", rebuildIndex: true });
  });

  it("a search index that could not be updated fails the run, and says every chat is in", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), { restore: { indexError: "the search worker is down" } });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("every chat is restored");
    expect(ended.message).toContain("the search worker is down");
    // it names controls that exist: the debug call, and the same command again
    expect(ended.message).toContain("haevnDebug.rebuildIndex()");
    expect(ended.message).toContain("run the same command again");
    expect(ended.message).not.toContain("settings");
    expect(t.extension.receivedRecords.size).toBe(4);
  });

  it("closes the restore it opened when the answer to restoreBegin cannot be read, and writes nothing", async () => {
    const dir = await makeBackup(backedUp());
    const t = await target(archiveNow(), {
      restore: { beginAnswer: { idleTimeoutMs: 120_000 } },
    });

    const ended = await endedAs(restore(dir, t));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("no indexPerChat");
    // nothing was written, so there is nothing to finish by running it again
    expect(ended.message).not.toContain("same command again");
    expect(t.extension.receivedRecords.size).toBe(0);
    // the extension was told to give its lock back, not left to wait for its own idle timer
    expect(t.extension.restoreEvents.map((e) => e.kind)).toEqual(["begin", "finish"]);
  });

  it("ends as interrupted when the signal fires, and still closes the restore", async () => {
    const dir = await makeBackup(backedUp());
    const controller = new AbortController();
    const t = await target(archiveNow(), {
      fault: (frame, n): Fault | undefined => {
        if (frame.action === "restoreChat" && frame.chatId === "claude:b2" && n === 1)
          controller.abort();
        return undefined;
      },
    });

    const ended = await endedAs(restore(dir, t, { signal: controller.signal }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("interrupted");
    expect(ended.message).toContain("Running the same command again finishes the restore");
    await vi.waitFor(() => expect(restoreRequests(t).at(-1)).toBe("restoreFinish"));
  });
});
