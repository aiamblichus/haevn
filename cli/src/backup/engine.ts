/**
 * `haevn backup`: the engine (HVN-135; architecture/backup-restore, "Backup: the algorithm").
 *
 * The CLI owns the loop and the extension answers one small request at a time: it lists the live
 * chats, then reads each chat's record and each media file through the daemon's pipe. This module
 * writes them into `<dir>.partial`, checks every byte count, hashes every file, writes `index.jsonl`
 * and then `manifest.json`, and swaps the finished directory for the previous one. A run that does
 * not finish leaves the previous `<dir>` as it was and no `.partial`.
 *
 * It ends one of three ways, and the unattended runner reads which: it returns (0), it throws
 * `deferred` (75, "not now, ask again") or it throws `failed` (1). The table is in `commands/backup.ts`.
 *
 * Strict: one item that cannot be read fails the run. Two things are not failures: a chat that
 * vanished between the listing and its reading (its id goes into the manifest), and a transfer that
 * did not get through, which is tried again, at most `RETRY_DELAYS_MS.length` more times (below).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DaemonCallError, type DaemonEndpoint, pipeOut } from "../daemon/client.js";
import type { BackupListedChat, PipeActionBody } from "../types.js";
import { deferred, failed } from "../utils/exit.js";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  CHATS_DIR,
  foldName,
  INDEX_FILE,
  type IndexEntry,
  type IndexMedia,
  isSafeFileName,
  MANIFEST_FILE,
  type Manifest,
  MEDIA_DIR,
  PID_FILE,
  StemAllocator,
} from "./layout.js";
import { ExtensionLink, errorText, toExitError } from "./link.js";

export { BACKUP_PROTOCOL, RETRY_DELAYS_MS } from "./link.js";

/** A live `.partial` older than this is not a run any more (a reused pid after a reboot). */
const PARTIAL_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** A `.partial` with no pid file that is younger than this was just claimed by another run. */
const PARTIAL_CLAIM_GRACE_MS = 60_000;

export interface BackupOptions {
  /** The directory the backup ends up in. */
  dir: string;
  /** The daemon to use, or to start in this process when nothing listens there. */
  endpoint: DaemonEndpoint;
  /** How long to wait for the extension to connect, or to come back, before 75. */
  waitMs: number;
  /** Ends the run: it fails as interrupted, and cleans up. */
  signal?: AbortSignal;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
  /** For tests: the polling interval, the retry pauses and the page size. */
  timing?: { pollMs?: number; retryDelaysMs?: number[]; pageSize?: number };
}

export interface BackupResult {
  dir: string;
  chats: number;
  mediaFiles: number;
  /** Chat records and media files together. */
  bytes: number;
  vanished: string[];
  ms: number;
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const dir = path.resolve(options.dir);
  const partial = `${dir}.partial`;
  claimPartial(dir);
  let link: ExtensionLink | undefined;
  try {
    prepareDirectory(dir);
    link = await ExtensionLink.open(options.endpoint, options);
    return await new BackupRun(options, dir, link).run();
  } catch (err) {
    // Not another run's directory: a run that outlived the 2 h limit may find its `.partial` taken.
    if (!heldByAnotherRun(partial)) fs.rmSync(partial, { recursive: true, force: true });
    throw toExitError(err, options.signal);
  } finally {
    await link?.stop();
  }
}

// ─── The run ──────────────────────────────────────────────────────────────────

class BackupRun {
  private readonly partial: string;
  private readonly old: string;
  private readonly signal?: AbortSignal;
  private readonly endpoint: DaemonEndpoint;

  constructor(
    private readonly options: BackupOptions,
    private readonly dir: string,
    private readonly link: ExtensionLink,
  ) {
    this.partial = `${dir}.partial`;
    this.old = `${dir}.old`;
    this.signal = options.signal;
    this.endpoint = link.endpoint;
  }

  async run(): Promise<BackupResult> {
    const started = Date.now();
    const info = await this.link.connect();

    const listing = await this.link.listChats();
    const names = new StemAllocator();
    const index: IndexEntry[] = [];
    const vanished: string[] = [];
    let mediaFiles = 0;
    let bytes = 0;

    for (const [n, chat] of listing.entries()) {
      this.signal?.throwIfAborted();
      if (n > 0 && n % 250 === 0) this.options.log?.(`${n} of ${listing.length} chats`);
      const entry = await this.backupChat(chat, names.assign(chat.id));
      if (!entry) {
        vanished.push(chat.id);
        continue;
      }
      index.push(entry);
      mediaFiles += entry.media.length;
      bytes += entry.bytes + entry.media.reduce((sum, m) => sum + m.bytes, 0);
    }

    // A restore that opened and closed while the run was reading met none of its actions open (each
    // checks at its start), so the counter is the only trace it leaves (HVN-144). Nothing is kept.
    const later = await this.link.backupInfo();
    if (later.restoreEpoch !== info.restoreEpoch) {
      throw deferred(
        `a restore began while the backup was reading; this run was discarded and ${this.dir} is as it was, run the backup again`,
      );
    }

    fs.rmSync(path.join(this.partial, PID_FILE), { force: true });
    await writeDurable(
      path.join(this.partial, INDEX_FILE),
      index.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    );
    const manifest: Manifest = {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      haevnVersion: info.haevnVersion,
      dbSchema: info.dbSchema,
      chats: index.length,
      mediaFiles,
      bytes,
      vanished,
    };
    await writeDurable(
      path.join(this.partial, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    for (const sub of [CHATS_DIR, MEDIA_DIR, ""]) syncDir(path.join(this.partial, sub));

    this.signal?.throwIfAborted();
    swap(this.partial, this.dir, this.old);
    return {
      dir: this.dir,
      chats: index.length,
      mediaFiles,
      bytes,
      vanished,
      ms: Date.now() - started,
    };
  }

  /** One chat's record and media into `.partial`; null when the chat is gone. */
  private async backupChat(chat: BackupListedChat, stem: string): Promise<IndexEntry | null> {
    const file = `${CHATS_DIR}/${stem}.jsonl`;
    const record = await this.link.attempt(
      `chat ${chat.id}`,
      () => this.receive({ action: "backupChat", chatId: chat.id }, file, undefined),
      { missingIsOk: true },
    );
    if (!record) return null;

    const mediaDir = chat.media.length > 0 ? `${MEDIA_DIR}/${stem}` : null;
    const seen = new Set<string>();
    const media: IndexMedia[] = [];
    for (const item of chat.media) {
      if (!isSafeFileName(item.name)) {
        throw failed(
          `chat ${chat.id}: the extension lists a media file with the name ${JSON.stringify(item.name)}, which is not a file name`,
        );
      }
      if (seen.has(foldName(item.name))) {
        throw failed(
          `chat ${chat.id}: two media files, one of them ${JSON.stringify(item.name)}, differ only by case or accents, and would share a file on this disk`,
        );
      }
      seen.add(foldName(item.name));
      const got = await this.link.attempt(`media ${item.name} of chat ${chat.id}`, () =>
        this.receive(
          { action: "backupMedia", chatId: chat.id, name: item.name },
          `${mediaDir}/${item.name}`,
          item.bytes,
        ),
      );
      media.push({ name: item.name, bytes: got.bytes, sha256: got.sha256 });
    }
    if (mediaDir) syncDir(path.join(this.partial, mediaDir));
    return {
      id: chat.id,
      source: chat.source,
      file,
      bytes: record.bytes,
      sha256: record.sha256,
      mediaDir,
      media,
    };
  }

  /**
   * Ask for one record or file and write it to `relative` under `.partial`. Its length is checked
   * against what the extension declared (a stream that ends early is a failed transfer) and, for a
   * media file, against the listing: the daemon's late error frame never reaches this side, so the
   * count is the only proof that all of it came.
   */
  private async receive(
    action: PipeActionBody,
    relative: string,
    listedBytes: number | undefined,
  ): Promise<{ bytes: number; sha256: string }> {
    const { length, body } = await pipeOut(this.endpoint, action, this.signal);
    const reader = body.getReader();
    const target = path.join(this.partial, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await fsp.open(target, "w");
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (this.signal?.aborted) throw err;
          throw new DaemonCallError(
            "transport",
            `the transfer was cut after ${bytes} bytes: ${errorText(err)}`,
          );
        }
        if (chunk.done) break;
        hash.update(chunk.value);
        bytes += chunk.value.length;
        for (let written = 0; written < chunk.value.length; ) {
          written += (await handle.write(chunk.value, written, chunk.value.length - written))
            .bytesWritten;
        }
      }
      await handle.sync();
    } finally {
      await handle.close();
      await reader.cancel().catch(() => undefined);
    }

    // A record's count is checked against its Content-Length by `fetch` itself: a body that ends
    // short (or runs long) rejects the read above, which is a failed transfer. What is left to check
    // here is that a length was declared at all, and, for a media file, the listing.
    if (length === null) {
      throw new DaemonCallError("protocol", "the daemon sent bytes without a Content-Length");
    }
    if (listedBytes !== undefined && bytes !== listedBytes) {
      throw failed(
        `${describe(action)} is ${bytes} bytes and the listing said ${listedBytes}: it changed during the run`,
      );
    }
    return { bytes, sha256: hash.digest("hex") };
  }
}

// ─── The directory ────────────────────────────────────────────────────────────

/** What a `.partial` of ours can hold: nothing else is ours to delete. */
const PARTIAL_NAMES = new Set([PID_FILE, INDEX_FILE, MANIFEST_FILE, CHATS_DIR, MEDIA_DIR]);

/** Whether `dir` is a directory (not a link to one) holding nothing. */
function isEmptyDirectory(dir: string): boolean {
  return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0;
}

/** Whether `dir` is a directory (not a link to one) with the manifest of a haevn backup. */
function isBackup(dir: string): boolean {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"),
    ) as Partial<Manifest>;
    return manifest.format === BACKUP_FORMAT;
  } catch {
    return false; // no manifest, or not JSON
  }
}

/**
 * Every removal or rename-back of a path that a suffix names (`<dir>.old`, `<dir>.partial`) asks
 * this first, because the suffix alone proves nothing: `notes.old` may be a person's folder. A
 * `.old` is ours when it is empty or is a haevn backup; a `.partial` when it is empty or holds only
 * the names a run writes. Anything else ends the run (1) with the path named.
 */
function requireOurs(target: string, kind: "old" | "partial"): void {
  let ours: boolean;
  try {
    ours =
      isEmptyDirectory(target) ||
      (kind === "old"
        ? isBackup(target)
        : fs.lstatSync(target).isDirectory() &&
          fs.readdirSync(target).every((name) => PARTIAL_NAMES.has(name)));
  } catch (err) {
    throw toExitError(err);
  }
  if (!ours) {
    throw failed(`refusing to remove ${target}: it is not part of a haevn backup`);
  }
}

/**
 * Take `<dir>.partial`. A live run's `backup.pid` in it means 75; one left by a run that died is
 * removed with it, if it is ours to remove. `mkdir` is the claim, so two runs started together
 * cannot both have it: the one that loses the second `mkdir` is told to come back (75).
 */
function claimPartial(dir: string): void {
  const partial = `${dir}.partial`;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
  } catch (err) {
    throw toExitError(err);
  }
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(partial);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw toExitError(err);
      const owner = liveOwner(partial);
      if (owner || tries > 0) {
        throw deferred(
          `another haevn backup${owner?.pid ? ` (pid ${owner.pid})` : ""} is writing ${partial}`,
        );
      }
      requireOurs(partial, "partial");
      fs.rmSync(partial, { recursive: true, force: true });
    }
  }
  try {
    fs.writeFileSync(
      path.join(partial, PID_FILE),
      `${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`,
    );
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw toExitError(err);
  }
}

/** The pid a `.partial` names, if its pid file is there and says one. */
function recordedPid(partial: string): number | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(partial, PID_FILE), "utf8")) as {
      pid?: unknown;
    };
    return typeof info.pid === "number" ? info.pid : undefined;
  } catch {
    return undefined;
  }
}

/** `.partial` names another process: it is that run's, not ours to clean up. */
function heldByAnotherRun(partial: string): boolean {
  const pid = recordedPid(partial);
  return pid !== undefined && pid !== process.pid;
}

/** The run that holds an existing `.partial`, or null when it is a leftover. */
function liveOwner(partial: string): { pid?: number } | null {
  let info: { pid?: unknown; startedAt?: unknown };
  try {
    info = JSON.parse(fs.readFileSync(path.join(partial, PID_FILE), "utf8"));
  } catch {
    // No pid file: just claimed by a run that has not written it yet, or a leftover.
    try {
      return Date.now() - fs.statSync(partial).mtimeMs < PARTIAL_CLAIM_GRACE_MS ? {} : null;
    } catch {
      return null;
    }
  }
  if (typeof info.pid !== "number" || typeof info.startedAt !== "number") return null;
  if (Date.now() - info.startedAt > PARTIAL_MAX_AGE_MS) return null;
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    // ESRCH: no such process. EPERM: it exists and is somebody else's.
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return { pid: info.pid };
}

/**
 * Before the work: a `<dir>.old` left by a swap that was killed between its renames is the previous
 * backup, and goes back; any other `.old` of ours is removed. A `.old` that is not ours is left
 * alone and ends the run.
 */
function prepareDirectory(dir: string): void {
  const old = `${dir}.old`;
  if (exists(old)) {
    requireOurs(old, "old");
    if (!exists(dir) && isBackup(old)) fs.renameSync(old, dir);
    else fs.rmSync(old, { recursive: true, force: true });
  }
  requireReplaceable(dir);
}

/** `<dir>` may be replaced when it is missing, empty, or a haevn backup. It is not a link. */
function requireReplaceable(dir: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return; // nothing there
  }
  if (stat.isSymbolicLink()) {
    throw failed(`${dir} is a symbolic link: give the directory itself, not a link to it`);
  }
  if (!stat.isDirectory()) throw failed(`${dir} exists and is not a directory`);
  if (isEmptyDirectory(dir) || isBackup(dir)) return;
  throw failed(
    `${dir} is not empty and is not a haevn backup (it has no ${MANIFEST_FILE}): refusing to replace it`,
  );
}

function exists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The finished `.partial` becomes `<dir>`. The previous `<dir>` goes to `<dir>.old` first and is
 * removed last, so a kill between the renames leaves a complete `.old` (which `prepareDirectory`
 * puts back) and never a `<dir>` without a manifest. `<dir>` is checked again first: the run took
 * minutes, and what is in `<dir>` now is what gets moved and deleted.
 */
export function swap(partial: string, dir: string, old: string): void {
  requireReplaceable(dir);
  const hadPrevious = exists(dir);
  if (hadPrevious) fs.renameSync(dir, old);
  try {
    fs.renameSync(partial, dir);
  } catch (err) {
    if (hadPrevious) fs.renameSync(old, dir);
    throw err;
  }
  syncDir(path.dirname(dir));
  try {
    fs.rmSync(old, { recursive: true, force: true });
  } catch {
    // The backup is in place; the next run removes what is left.
  }
}

async function writeDurable(file: string, text: string): Promise<void> {
  const handle = await fsp.open(file, "w");
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Flush a directory's entries to disk. Best effort: not every platform lets a directory be opened. */
function syncDir(dir: string): void {
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // not supported here
  }
}

// ─── Small things ─────────────────────────────────────────────────────────────

function describe(action: PipeActionBody): string {
  return action.action === "backupMedia"
    ? `media file ${String(action.name)} of chat ${String(action.chatId)}`
    : `the record of chat ${String(action.chatId)}`;
}
