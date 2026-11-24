import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDaemon } from "../daemon/client.js";
import { startDaemon } from "../daemon/server.js";
import {
  defaultRecord,
  type FakeChat,
  FakeExtension,
  type FakeExtensionOptions,
  type Fault,
} from "../testing/fakeExtension.js";
import { ExitError } from "../utils/exit.js";
import {
  type BackupOptions,
  type BackupResult,
  RETRY_DELAYS_MS,
  runBackup,
  swap,
} from "./engine.js";
import type { IndexEntry, Manifest } from "./layout.js";

const KEY = "test-key";

let root: string;
const extensions: FakeExtension[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-backup-test-"));
  // The daemon logs its life to stderr; keep the test output readable.
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(async () => {
  for (const extension of extensions.splice(0)) extension.stop();
  for (const close of closers.splice(0)) await close();
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

interface Setup {
  dir: string;
  port: number;
  extension: FakeExtension;
}

/** A backup directory, a free port, and an extension that connects to it once a daemon is there. */
async function setup(
  chats: FakeChat[],
  extensionOptions: FakeExtensionOptions = {},
  { start = true }: { start?: boolean } = {},
): Promise<Setup> {
  const port = await freePort();
  const extension = new FakeExtension(port, chats, extensionOptions);
  extensions.push(extension);
  if (start) extension.start();
  return { dir: path.join(root, "archive"), port, extension };
}

function backup(s: Setup, options: Partial<BackupOptions> = {}): Promise<BackupResult> {
  return runBackup({
    dir: s.dir,
    endpoint: { port: s.port, apiKey: KEY },
    waitMs: 5_000,
    timing: { pollMs: 20, retryDelaysMs: [5, 5], pageSize: 2 },
    ...options,
  });
}

/** What a run that ends early ended as: its exit code and its line. */
async function endedAs(run: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ExitError) return { code: err.exitCode, message: err.message };
    throw err;
  }
  throw new Error("the backup finished; it was meant to end early");
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `dir`: path from `dir` to its content hash. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = sha(fs.readFileSync(full));
    }
  };
  walk(dir);
  return files;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
}

function readIndex(dir: string): IndexEntry[] {
  return fs
    .readFileSync(path.join(dir, "index.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as IndexEntry);
}

/** The backup is whole: every file in the index is there at the size and hash it says, and nothing else is. */
function expectConsistent(dir: string): void {
  const index = readIndex(dir);
  const expected = new Set(["manifest.json", "index.jsonl"]);
  for (const entry of index) {
    const record = fs.readFileSync(path.join(dir, entry.file));
    expect(record.length).toBe(entry.bytes);
    expect(sha(record)).toBe(entry.sha256);
    expected.add(entry.file);
    for (const media of entry.media) {
      const file = path.join(dir, entry.mediaDir as string, media.name);
      const data = fs.readFileSync(file);
      expect(data.length).toBe(media.bytes);
      expect(sha(data)).toBe(media.sha256);
      expected.add(path.join(entry.mediaDir as string, media.name));
    }
  }
  expect(Object.keys(snapshot(dir)).sort()).toEqual([...expected].sort());
}

/** A previous backup in `dir`, to see that a run which does not finish leaves it alone. */
function plantPrevious(dir: string): Record<string, string> {
  fs.mkdirSync(path.join(dir, "chats"), { recursive: true });
  fs.writeFileSync(path.join(dir, "chats", "old.jsonl"), "yesterday\n");
  fs.writeFileSync(path.join(dir, "index.jsonl"), "");
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    `${JSON.stringify({ format: "haevn-backup", version: 1, chats: 1, createdAt: "yesterday" })}\n`,
  );
  return snapshot(dir);
}

function expectPreviousKept(dir: string, before: Record<string, string>): void {
  expect(snapshot(dir)).toEqual(before);
  expect(fs.existsSync(`${dir}.partial`)).toBe(false);
  expect(fs.existsSync(`${dir}.old`)).toBe(false);
}

const photo = randomBytes(3 * 1024 * 1024 + 17);
const three: FakeChat[] = [
  { id: "claude:a1", source: "claude", media: [{ name: "msg1_0.png", data: photo }] },
  { id: "claude:b2", source: "claude" },
  { id: "chatgpt:c3", source: "chatgpt", media: [{ name: "x.txt", data: Buffer.from("x") }] },
];

// ─── 0: done ──────────────────────────────────────────────────────────────────

describe("haevn backup, a run that finishes (exit 0)", () => {
  it("writes every chat and media file, hashed, with the manifest last, and replaces the previous backup", async () => {
    const s = await setup(three);
    const before = plantPrevious(s.dir);
    expect(before["chats/old.jsonl"]).toBeDefined();

    const result = await backup(s);

    expect(result.chats).toBe(3);
    expect(result.mediaFiles).toBe(2);
    expect(result.vanished).toEqual([]);
    const manifest = readManifest(s.dir);
    expect(manifest).toMatchObject({
      format: "haevn-backup",
      version: 1,
      haevnVersion: "9.9.9-test",
      dbSchema: 21,
      chats: 3,
      mediaFiles: 2,
      vanished: [],
    });
    expect(manifest.bytes).toBe(
      three.reduce((n, c) => n + defaultRecord(c.id).length, 0) + photo.length + 1,
    );
    expectConsistent(s.dir);
    // the record is the bytes the extension sent; the media file is byte for byte
    const index = readIndex(s.dir);
    const a1 = index.find((e) => e.id === "claude:a1") as IndexEntry;
    expect(a1.file).toBe("chats/claude%3Aa1.jsonl");
    expect(fs.readFileSync(path.join(s.dir, a1.file))).toEqual(defaultRecord("claude:a1"));
    expect(fs.readFileSync(path.join(s.dir, "media/claude%3Aa1/msg1_0.png"))).toEqual(photo);
    expect(index.find((e) => e.id === "claude:b2")?.mediaDir).toBeNull();
    // the three pages of two chats were asked for in key order
    expect(s.extension.asked.filter((q) => q.startsWith("backupList"))).toHaveLength(2);
    // the old backup is gone, the partial and the old directory too
    expect(fs.existsSync(path.join(s.dir, "chats/old.jsonl"))).toBe(false);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
    expect(fs.existsSync(`${s.dir}.old`)).toBe(false);
  });

  it("stops the daemon it started when it is done", async () => {
    const s = await setup(three);
    await backup(s);
    await expect(fetch(`http://127.0.0.1:${s.port}/health`)).rejects.toThrow();
  });

  it("uses a daemon that is already running, and leaves it running", async () => {
    const s = await setup(three, {}, { start: false });
    const standing = await startDaemon({ port: s.port, apiKey: KEY });
    closers.push(() => standing.stop());
    s.extension.start();

    await backup(s);

    expect((await fetch(`http://127.0.0.1:${s.port}/health`)).status).toBe(200);
    expectConsistent(s.dir);
  });

  it("backs up an archive with no chats", async () => {
    const s = await setup([]);
    const result = await backup(s);
    expect(result.chats).toBe(0);
    expect(readManifest(s.dir)).toMatchObject({ chats: 0, mediaFiles: 0, bytes: 0 });
    expectConsistent(s.dir);
  });

  it("keeps a media file whose name is not ASCII, and a chat id that is not a file name", async () => {
    const name = "изображение-é-日本.png";
    const id = "gemini:ß/ü ../?";
    const data = randomBytes(1000);
    const s = await setup([{ id, source: "gemini", media: [{ name, data }] }]);

    await backup(s);

    const entry = readIndex(s.dir)[0];
    expect(entry.id).toBe(id);
    expect(entry.media[0].name).toBe(name);
    expect(entry.file).toMatch(/^chats\/[A-Za-z0-9%._~!*'()-]+\.jsonl$/);
    // the file is on the disk under the name the extension gave, and it holds the bytes
    const onDisk = fs.readdirSync(path.join(s.dir, entry.mediaDir as string));
    expect(onDisk.map((f) => f.normalize("NFC"))).toEqual([name.normalize("NFC")]);
    expect(fs.readFileSync(path.join(s.dir, entry.mediaDir as string, name))).toEqual(data);
    expectConsistent(s.dir);
  });

  it("gives chats whose ids differ only by case files of their own (a disk that folds case)", async () => {
    const s = await setup([
      {
        id: "Abc",
        record: Buffer.from("upper\n"),
        media: [{ name: "m.png", data: Buffer.from("U") }],
      },
      {
        id: "abc",
        record: Buffer.from("lower\n"),
        media: [{ name: "m.png", data: Buffer.from("L") }],
      },
      { id: "abc~2", record: Buffer.from("tilde\n") },
    ]);

    await backup(s);

    const byId = new Map(readIndex(s.dir).map((e) => [e.id, e]));
    const names = [...byId.values()].map((e) => e.file.toLowerCase());
    expect(new Set(names).size).toBe(3); // no two files whose names fold to one
    expect(byId.get("Abc")?.file).toBe("chats/Abc.jsonl"); // "Abc" sorts first and keeps its name
    expect(byId.get("abc")?.file).toBe("chats/abc~2.jsonl");
    expect(byId.get("abc~2")?.file).toBe("chats/abc~2~2.jsonl");
    // each chat's own bytes, which a shared name would have overwritten
    const read = (id: string) =>
      fs.readFileSync(path.join(s.dir, byId.get(id)?.file as string), "utf8");
    expect([read("Abc"), read("abc"), read("abc~2")]).toEqual(["upper\n", "lower\n", "tilde\n"]);
    const mediaOf = (id: string) =>
      fs.readFileSync(path.join(s.dir, byId.get(id)?.mediaDir as string, "m.png"), "utf8");
    expect([mediaOf("Abc"), mediaOf("abc")]).toEqual(["U", "L"]);
    expectConsistent(s.dir);
  });

  it("puts a chat that vanished between the listing and its reading in the manifest, and is not failed by it", async () => {
    const s = await setup([
      { id: "a" },
      { id: "b", vanished: true, media: [{ name: "m.png", data: Buffer.from("m") }] },
      { id: "c" },
    ]);

    const result = await backup(s);

    expect(result.vanished).toEqual(["b"]);
    expect(readManifest(s.dir)).toMatchObject({ chats: 2, vanished: ["b"] });
    expect(readIndex(s.dir).map((e) => e.id)).toEqual(["a", "c"]);
    expect(fs.existsSync(path.join(s.dir, "media"))).toBe(false); // b's media was never asked for
    expectConsistent(s.dir);
  });

  it("waits for an extension that connects late", async () => {
    const s = await setup(three, { connectAfterMs: 300 });
    const result = await backup(s, { waitMs: 3_000 });
    expect(result.chats).toBe(3);
  });
});

// ─── The retries ──────────────────────────────────────────────────────────────

describe("haevn backup, a transfer that does not get through", () => {
  it("is tried three times in all, with a pause that grows, unless a test shortens it", () => {
    expect(RETRY_DELAYS_MS).toEqual([500, 2_000]);
  });

  it("tries a cut stream again, and a spent pipe id again, and finishes", async () => {
    const s = await setup(three, {
      fault: (frame, n): Fault | undefined => {
        if (frame.action === "backupMedia" && frame.name === "msg1_0.png" && n === 1) return "cut";
        if (frame.action === "backupChat" && frame.chatId === "claude:b2" && n === 1)
          return "spent";
        return undefined;
      },
    });

    await backup(s);

    expect(s.extension.asked.filter((q) => q.includes("msg1_0.png"))).toHaveLength(2);
    expect(s.extension.asked.filter((q) => q === "backupChat claude:b2")).toHaveLength(2);
    expectConsistent(s.dir);
    expect(fs.readFileSync(path.join(s.dir, "media/claude%3Aa1/msg1_0.png"))).toEqual(photo);
  });

  it("gives up after three tries in all, and fails the run (exit 1) with the previous backup in place", async () => {
    const s = await setup(three, {
      fault: (frame): Fault | undefined => (frame.chatId === "claude:b2" ? "cut" : undefined),
    });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("chat claude:b2");
    expect(ended.message).toContain("3 tries");
    expect(s.extension.asked.filter((q) => q === "backupChat claude:b2")).toHaveLength(3);
    expectPreviousKept(s.dir, before);
  });
});

// ─── 75: not now ──────────────────────────────────────────────────────────────

describe("haevn backup, not now (exit 75)", () => {
  it("nobody connects within --wait", async () => {
    const s = await setup(three, {}, { start: false });
    const before = plantPrevious(s.dir);
    const started = Date.now();

    const ended = await endedAs(backup(s, { waitMs: 300 }));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("no extension connected within");
    expect(Date.now() - started).toBeLessThan(3_000);
    expectPreviousKept(s.dir, before);
  });

  it("the extension answers BUSY (a restore is running)", async () => {
    const s = await setup(three, {
      fault: (frame): Fault | undefined =>
        frame.action === "backupChat"
          ? { error: "BUSY", message: "a restore is running" }
          : undefined,
    });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("a restore is running");
    expectPreviousKept(s.dir, before);
  });

  it("another live haevn backup holds <dir>.partial, and its files are left alone", async () => {
    const s = await setup(three);
    const before = plantPrevious(s.dir);
    fs.mkdirSync(`${s.dir}.partial`);
    fs.writeFileSync(
      path.join(`${s.dir}.partial`, "backup.pid"),
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
    );
    fs.writeFileSync(path.join(`${s.dir}.partial`, "half.jsonl"), "half a chat\n");

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain(`pid ${process.pid}`);
    expect(snapshot(s.dir)).toEqual(before);
    expect(snapshot(`${s.dir}.partial`)["half.jsonl"]).toBeDefined();
    expect(s.extension.asked).toEqual([]); // it did not even connect
  });

  it("a .partial of a run that died is removed, and the run goes on", async () => {
    const s = await setup(three);
    fs.mkdirSync(`${s.dir}.partial`);
    // a pid that is not running: a process that has exited
    const exited = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", ""]);
      child.on("exit", () => resolve(child.pid as number));
    });
    fs.writeFileSync(
      path.join(`${s.dir}.partial`, "backup.pid"),
      JSON.stringify({ pid: exited, startedAt: Date.now() }),
    );
    fs.mkdirSync(path.join(`${s.dir}.partial`, "chats"));
    fs.writeFileSync(path.join(`${s.dir}.partial`, "chats", "half.jsonl"), "x");

    await backup(s);

    expectConsistent(s.dir);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("the connection is lost and does not return within --wait", async () => {
    const s = await setup(three, {
      fault: (frame): Fault | undefined =>
        frame.action === "backupChat" && frame.chatId === "claude:b2" ? { drop: true } : undefined,
    });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s, { waitMs: 300 }));

    expect(ended.code).toBe(75);
    expect(ended.message).toContain("lost");
    expectPreviousKept(s.dir, before);
  });

  it("the connection is lost and comes back within --wait: the item is tried again and the run finishes", async () => {
    const s = await setup(three, {
      fault: (frame, n): Fault | undefined =>
        frame.action === "backupChat" && frame.chatId === "claude:b2" && n === 1
          ? { drop: true, returnAfterMs: 150 }
          : undefined,
    });

    await backup(s, { waitMs: 5_000 });

    expect(s.extension.asked.filter((q) => q === "backupChat claude:b2")).toHaveLength(2);
    expectConsistent(s.dir);
  });
});

// ─── 1: failed ────────────────────────────────────────────────────────────────

describe("haevn backup, failed (exit 1)", () => {
  it("an item cannot be read: the run fails, the previous backup stays, no .partial is left", async () => {
    const s = await setup(three, {
      fault: (frame): Fault | undefined =>
        frame.action === "backupChat" && frame.chatId === "claude:b2"
          ? { error: "INTERNAL_ERROR", message: "the row would not parse" }
          : undefined,
    });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("chat claude:b2");
    expect(ended.message).toContain("the row would not parse");
    expect(s.extension.asked.filter((q) => q === "backupChat claude:b2")).toHaveLength(1); // not retried
    expectPreviousKept(s.dir, before);
  });

  it("a media file that is gone is an item error, unlike a chat that is gone", async () => {
    const chats: FakeChat[] = [{ id: "a", media: [{ name: "m.png", data: Buffer.from("m") }] }];
    const s = await setup(chats, {
      fault: (frame): Fault | undefined =>
        frame.action === "backupMedia"
          ? { error: "NOT_FOUND", message: "no such file" }
          : undefined,
    });

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("m.png");
  });

  it("a media file whose size is not the one in the listing is refused, though the transfer was clean", async () => {
    const s = await setup([
      { id: "a", media: [{ name: "grew.png", data: Buffer.alloc(120, 1), listedBytes: 100 }] },
    ]);
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("grew.png");
    expect(ended.message).toContain("120 bytes and the listing said 100");
    expectPreviousKept(s.dir, before);
  });

  it("a media file shorter than the listing is refused too", async () => {
    const s = await setup([
      { id: "a", media: [{ name: "short.png", data: Buffer.alloc(80, 1), listedBytes: 100 }] },
    ]);
    const ended = await endedAs(backup(s));
    expect(ended.code).toBe(1);
    expect(ended.message).toContain("80 bytes and the listing said 100");
  });

  it("the extension is older than the backup actions (UNKNOWN_ACTION)", async () => {
    const s = await setup(three, { info: "unknown-action" });
    const before = plantPrevious(s.dir);
    const ended = await endedAs(backup(s));
    expect(ended.code).toBe(1);
    expect(ended.message).toContain("update the extension");
    expectPreviousKept(s.dir, before);
  });

  it("the extension speaks another backup protocol", async () => {
    const newer = await setup(three, { info: { protocol: 2 } });
    expect((await endedAs(backup(newer))).message).toContain("update the CLI");
    const older = await setup(three, { info: { protocol: 0 } });
    older.dir = path.join(root, "second");
    expect((await endedAs(backup(older))).message).toContain("update the extension");
  });

  it("the extension connects with another API key than the daemon's", async () => {
    const s = await setup(three, { key: "some-other-key" });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s, { waitMs: 3_000 }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("different API key");
    expectPreviousKept(s.dir, before);
  });

  it("a stray socket with a wrong key does not fail a run whose extension is connected", async () => {
    const s = await setup(three, { connectAfterMs: 200 });
    // the stray dials in first, as a web page or another extension with a key of its own may
    const stray = new FakeExtension(s.port, [], { key: "not-the-key" });
    extensions.push(stray);
    stray.start();

    const result = await backup(s, { waitMs: 5_000 });

    expect(result.chats).toBe(3);
    expectConsistent(s.dir);
  });

  it("a daemon that is already running refuses the key", async () => {
    const s = await setup(three, { key: "the-daemons-key" }, { start: false });
    const standing = await startDaemon({ port: s.port, apiKey: "the-daemons-key" });
    closers.push(() => standing.stop());
    s.extension.start();

    const ended = await endedAs(backup(s)); // its own key is "test-key"

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("refused the API key");
  });

  it("a daemon that is already running and predates the pipe: restart it", async () => {
    const port = await freePort();
    const old = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/health" ? { ok: true, extensionConnected: true } : {}));
    });
    await new Promise<void>((resolve) => old.listen(port, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => old.close(() => resolve())));

    const ended = await endedAs(
      runBackup({ dir: path.join(root, "archive"), endpoint: { port, apiKey: KEY }, waitMs: 500 }),
    );

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("restart it");
    expect(fs.existsSync(path.join(root, "archive.partial"))).toBe(false);
  });

  it("a daemon that sends bytes without saying how many is refused, not trusted", async () => {
    const port = await freePort();
    const json = (res: http.ServerResponse, body: unknown) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    };
    const odd = http.createServer((req, res) => {
      if (req.url === "/health") return json(res, { ok: true, extensionConnected: true, pipe: 1 });
      if (req.url === "/pipe/out") {
        res.write("a record, chunked"); // no Content-Length
        return res.end();
      }
      req.resume();
      if (req.url === "/api") {
        return json(res, {
          id: "1",
          success: true,
          data: {
            protocol: 1,
            haevnVersion: "x",
            dbSchema: 21,
            liveChats: 1,
            chats: [{ id: "a", source: "s", media: [] }],
          },
        });
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => odd.listen(port, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => odd.close(() => resolve())));

    const ended = await endedAs(
      runBackup({ dir: path.join(root, "archive"), endpoint: { port, apiKey: KEY }, waitMs: 500 }),
    );

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("without a Content-Length");
    expect(fs.existsSync(path.join(root, "archive.partial"))).toBe(false);
  });

  it("the port is held by something that is not a daemon", async () => {
    const port = await freePort();
    const other = http.createServer((_req, res) => res.end("<html>hello</html>"));
    await new Promise<void>((resolve) => other.listen(port, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => other.close(() => resolve())));

    const ended = await endedAs(
      runBackup({ dir: path.join(root, "archive"), endpoint: { port, apiKey: KEY }, waitMs: 500 }),
    );

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("not the HAEVN daemon");
  });

  it("a disk error: the directory cannot be made", async () => {
    const s = await setup(three);
    fs.writeFileSync(path.join(root, "a-file"), "x");

    const ended = await endedAs(backup(s, { dir: path.join(root, "a-file", "archive") }));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("disk error");
  });

  it("a directory that is not a backup is not replaced", async () => {
    const s = await setup(three);
    fs.mkdirSync(s.dir);
    fs.writeFileSync(path.join(s.dir, "thesis.tex"), "years of work");

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("not a haevn backup");
    expect(fs.readFileSync(path.join(s.dir, "thesis.tex"), "utf8")).toBe("years of work");
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("an empty directory is replaced", async () => {
    const s = await setup(three);
    fs.mkdirSync(s.dir);
    await backup(s);
    expectConsistent(s.dir);
  });

  it("ends as interrupted when the signal fires, and removes its .partial", async () => {
    const controller = new AbortController();
    const s = await setup(three, {
      fault: (frame, n): Fault | undefined => {
        if (frame.action === "backupChat" && frame.chatId === "claude:b2" && n === 1) {
          controller.abort();
        }
        return undefined;
      },
    });
    const before = plantPrevious(s.dir);

    const ended = await endedAs(backup(s, { signal: controller.signal }));

    expect(ended).toEqual({ code: 1, message: "interrupted" });
    expectPreviousKept(s.dir, before);
  });
});

// ─── The swap ─────────────────────────────────────────────────────────────────

const PRECIOUS = "precious.txt";

function plantPrecious(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PRECIOUS), "mine\n");
}

function expectPreciousKept(dir: string): void {
  expect(fs.readFileSync(path.join(dir, PRECIOUS), "utf8")).toBe("mine\n");
}

describe("haevn backup, what it will not delete", () => {
  it("leaves a <dir>.old that is not a backup alone, with a backup in <dir>", async () => {
    const s = await setup(three);
    const before = plantPrevious(s.dir);
    plantPrecious(`${s.dir}.old`);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain(`${s.dir}.old`);
    expectPreciousKept(`${s.dir}.old`);
    expect(snapshot(s.dir)).toEqual(before);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("does not move a <dir>.old that is not a backup into <dir>", async () => {
    const s = await setup(three);
    plantPrecious(`${s.dir}.old`);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expectPreciousKept(`${s.dir}.old`);
    expect(fs.existsSync(s.dir)).toBe(false);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("leaves a <dir>.partial that holds anything but a run's own files alone", async () => {
    const s = await setup(three);
    plantPrecious(`${s.dir}.partial`);
    const old = new Date(Date.now() - 3_600_000); // not a claim of the last minute
    fs.utimesSync(`${s.dir}.partial`, old, old);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain(`${s.dir}.partial`);
    expectPreciousKept(`${s.dir}.partial`);
    expect(fs.existsSync(s.dir)).toBe(false);
  });

  it("removes a <dir>.old that is empty or is a backup, and a <dir>.partial that is empty", async () => {
    const s = await setup(three);
    const before = plantPrevious(s.dir);
    fs.mkdirSync(`${s.dir}.old`);
    fs.mkdirSync(`${s.dir}.partial`);
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(`${s.dir}.partial`, old, old);

    await backup(s);

    expectConsistent(s.dir);
    expect(before["chats/old.jsonl"]).toBeDefined();
    expect(fs.existsSync(`${s.dir}.old`)).toBe(false);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("does not replace what was put in <dir> while the run was going", async () => {
    const dir = path.join(root, "archive");
    const s = await setup(three, {
      fault: (frame): Fault | undefined => {
        if (frame.action === "backupChat" && !fs.existsSync(dir)) plantPrecious(dir);
        return undefined;
      },
    });

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("not a haevn backup");
    expectPreciousKept(dir);
    expect(fs.existsSync(`${dir}.partial`)).toBe(false);
    expect(fs.existsSync(`${dir}.old`)).toBe(false);
  });

  it("refuses a <dir> that is a symbolic link, and leaves the link and its target alone", async () => {
    const s = await setup(three);
    const target = path.join(root, "real-backup");
    const before = plantPrevious(target);
    fs.symlinkSync(target, s.dir);

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(1);
    expect(ended.message).toContain("symbolic link");
    expect(fs.lstatSync(s.dir).isSymbolicLink()).toBe(true);
    expect(snapshot(target)).toEqual(before);
    expect(fs.existsSync(`${s.dir}.partial`)).toBe(false);
  });

  it("leaves the .partial of another run alone when it ends, if that run has taken it", async () => {
    const s = await setup(three, {
      fault: (frame): Fault | undefined => {
        if (frame.action === "backupChat") {
          // a second run took the directory over (this one outlived the limit on its pid file)
          fs.writeFileSync(
            path.join(`${s.dir}.partial`, "backup.pid"),
            JSON.stringify({ pid: process.ppid, startedAt: Date.now() }),
          );
          return { error: "BUSY", message: "a restore is running" };
        }
        return undefined;
      },
    });

    const ended = await endedAs(backup(s));

    expect(ended.code).toBe(75);
    expect(
      JSON.parse(fs.readFileSync(path.join(`${s.dir}.partial`, "backup.pid"), "utf8")).pid,
    ).toBe(process.ppid);
  });
});

describe("haevn backup, the daemon it starts", () => {
  it("clears the timer that limits how long it waits to stop, so the process can exit at once", async () => {
    const session = await openDaemon({ port: await freePort(), apiKey: KEY });
    const set = vi.spyOn(globalThis, "setTimeout");
    const cleared = vi.spyOn(globalThis, "clearTimeout");

    await session.stop();

    const limits = set.mock.results.filter((_, i) => set.mock.calls[i][1] === 3_000);
    expect(limits).toHaveLength(1);
    expect(cleared.mock.calls.map(([timer]) => timer)).toContain(limits[0].value);
  });
});

describe("haevn backup, the swap", () => {
  it("puts the previous backup back when a run was killed between the two renames", async () => {
    const s = await setup(three, {}, { start: false });
    const before = plantPrevious(s.dir);
    fs.renameSync(s.dir, `${s.dir}.old`); // the state a kill between the renames leaves

    const ended = await endedAs(backup(s, { waitMs: 100 })); // and nobody connects

    expect(ended.code).toBe(75);
    expectPreviousKept(s.dir, before);
  });

  it("puts the previous backup back, whole, when the new one cannot be moved into place", () => {
    const dir = path.join(root, "archive");
    const before = plantPrevious(dir);

    // `.partial` is not there: the first rename (dir to .old) works, the second does not
    expect(() => swap(`${dir}.partial`, dir, `${dir}.old`)).toThrow(/ENOENT/);

    expectPreviousKept(dir, before);
  });

  it("moves the new backup in and the old one out", () => {
    const dir = path.join(root, "archive");
    plantPrevious(dir);
    fs.mkdirSync(`${dir}.partial`);
    fs.writeFileSync(path.join(`${dir}.partial`, "manifest.json"), "{}\n");

    swap(`${dir}.partial`, dir, `${dir}.old`);

    expect(Object.keys(snapshot(dir))).toEqual(["manifest.json"]);
    expect(fs.existsSync(`${dir}.partial`)).toBe(false);
    expect(fs.existsSync(`${dir}.old`)).toBe(false);
  });

  it("does not move or delete a <dir> that is not a backup, whatever checked it before", () => {
    const dir = path.join(root, "archive");
    plantPrecious(dir);
    fs.mkdirSync(`${dir}.partial`);
    fs.writeFileSync(path.join(`${dir}.partial`, "manifest.json"), "{}\n");

    expect(() => swap(`${dir}.partial`, dir, `${dir}.old`)).toThrow(/not a haevn backup/);

    expectPreciousKept(dir);
    expect(fs.existsSync(`${dir}.old`)).toBe(false);
    expect(fs.existsSync(`${dir}.partial`)).toBe(true); // the caller removes it
  });
});
