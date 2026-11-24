/**
 * `haevn restore`: the engine (HVN-137; architecture/backup-restore, "Restore: the algorithm").
 *
 * The CLI owns the loop and the extension answers one request at a time. In this order, and nothing
 * is written before the fifth step:
 *
 *   1. read the manifest and the index of the backup (a format or version this CLI does not know ends it)
 *   2. reach the extension, check the protocol and that its archive schema is not older than the backup's
 *   3. list the archive's live chats, so each chat of the backup is known to be replaced or added
 *   4. check every file's size and SHA-256 against `index.jsonl` (a damaged backup ends it)
 *   5. `--dry-run` stops here; otherwise the person confirms; then `restoreBegin`
 *   6. for each chat, its media files first and then its record (`/pipe/in`), each tried again when
 *      the transfer did not get through
 *   7. `restoreFinish`, in a `finally`: it gives the extension's lock back and rebuilds the index
 *
 * It ends one of three ways, as `haevn backup` does: it returns (0), it throws `deferred` (75: no
 * extension within `--wait`, the extension busy at `restoreBegin`, a lost connection that did not
 * return) or `failed` (1). Once the extension holds the session, any end but the last says that
 * running the same command again finishes the restore: every chat is whole or as it was.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { callFrame, DaemonCallError, type DaemonEndpoint, pipeIn } from "../daemon/client.js";
import type {
  PipeActionBody,
  RestoreBeginInfo,
  RestoreChatAnswer,
  RestoreFinishInfo,
} from "../types.js";
import { ExitError, failed } from "../utils/exit.js";
import type { IndexEntry } from "./layout.js";
import { ExtensionLink, errorText, toExitError } from "./link.js";
import { planOf, type RestorePlan } from "./plan.js";
import { readBackup, selectChats, verifyFiles } from "./readBackup.js";

export interface RestoreOptions {
  /** The backup directory. */
  dir: string;
  /** The daemon to use, or to start in this process when nothing listens there. */
  endpoint: DaemonEndpoint;
  /** How long to wait for the extension to connect, or to come back, before 75. */
  waitMs: number;
  /** Chat ids to restore; none means every chat of the backup. */
  chatIds?: string[];
  /** Check and count, write nothing. */
  dryRun?: boolean;
  /** Asked once, with the plan, before the first write. False ends the run (1). Absent: yes. */
  confirm?: (plan: RestorePlan) => Promise<boolean>;
  /** Ends the run: it fails as interrupted, and the extension is told to close the restore. */
  signal?: AbortSignal;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
  /** For tests: the polling interval, the retry pauses and the page size. */
  timing?: { pollMs?: number; retryDelaysMs?: number[]; pageSize?: number };
}

export interface RestoreResult {
  dryRun: boolean;
  plan: RestorePlan;
  /** Chats the extension replaced and chats it added; both 0 in a dry run. */
  replaced: number;
  added: number;
  mediaFiles: number;
  bytes: number;
  ms: number;
}

/** Said when a run ends after the extension opened its session. */
const RERUN =
  "Running the same command again finishes the restore: each chat is whole or as it was.";

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  const started = Date.now();
  const contents = readBackup(options.dir);
  const entries = selectChats(contents, dedupe(options.chatIds ?? []));

  let link: ExtensionLink | undefined;
  try {
    link = await ExtensionLink.open(options.endpoint, options);
    const info = await link.connect();
    if (info.dbSchema < contents.manifest.dbSchema) {
      throw failed(
        `the extension's archive is at schema ${info.dbSchema} and the backup is from schema ${contents.manifest.dbSchema}: update the extension first`,
      );
    }

    const listed = await link.listChats();
    const live = new Map(listed.map((chat) => [chat.id, chat]));
    const verified = await verifyFiles(contents, entries, {
      wantHeader: (entry) => live.has(entry.id),
      signal: options.signal,
      log: options.log,
    });

    const knowsSyncTimes = listed.some((chat) => chat.lastSyncedTimestamp !== undefined);
    const replacing = entries.filter((entry) => live.has(entry.id));
    // Not the same last sync as the backup's, or no way to tell (a record that does not say, an
    // archive that does not say): counted as changed, because it is better to overstate than to hide a loss
    const changed = replacing.filter(
      (entry) => live.get(entry.id)?.lastSyncedTimestamp !== verified.syncedAt.get(entry.id),
    ).length;
    const mediaFiles = entries.reduce((sum, entry) => sum + entry.media.length, 0);
    const bytes = entries.reduce(
      (sum, entry) => sum + entry.bytes + entry.media.reduce((s, m) => s + m.bytes, 0),
      0,
    );
    const plan = planOf(contents, {
      chats: entries.length,
      mediaFiles,
      bytes,
      replaced: replacing.length,
      changed: knowsSyncTimes ? changed : null,
      added: entries.length - replacing.length,
    });
    const nothing = { replaced: 0, added: 0, mediaFiles: 0, bytes: 0 };

    if (options.dryRun || entries.length === 0) {
      return { dryRun: options.dryRun === true, plan, ...nothing, ms: Date.now() - started };
    }
    if (options.confirm && !(await options.confirm(plan))) {
      throw failed("not confirmed: nothing was written");
    }

    const sent = await new RestoreRun(
      options,
      contents.dir,
      link,
      entries,
      new Set(live.keys()),
    ).run();
    return { dryRun: false, plan, ...sent, ms: Date.now() - started };
  } catch (err) {
    throw toExitError(err, options.signal);
  } finally {
    await link?.stop();
  }
}

// ─── The run ──────────────────────────────────────────────────────────────────

class RestoreRun {
  private readonly endpoint: DaemonEndpoint;
  private readonly signal?: AbortSignal;

  constructor(
    private readonly options: RestoreOptions,
    private readonly dir: string,
    private readonly link: ExtensionLink,
    private readonly entries: IndexEntry[],
    /** The chats that are live in the archive: the ones a restore replaces, as the plan counted them. */
    private readonly live: Set<string>,
  ) {
    this.endpoint = link.endpoint;
    this.signal = options.signal;
  }

  async run(): Promise<Pick<RestoreResult, "replaced" | "added" | "mediaFiles" | "bytes">> {
    const begin = await this.link.attempt("restoreBegin", () =>
      callFrame<RestoreBeginInfo>(
        this.endpoint,
        { action: "restoreBegin", chats: this.entries.length },
        this.signal,
      ),
    );

    const sent = { replaced: 0, added: 0, mediaFiles: 0, bytes: 0 };
    let finished: RestoreFinishInfo = {};
    let closeFailure: ExitError | undefined;
    let indexPerChat = true;
    let ok = false;
    // Nothing is written until the answer has been read, so a refusal of it needs no "run it again"
    let writing = false;
    try {
      // Inside the try: the session is open now, and `restoreFinish` must give its lock back
      if (typeof begin.indexPerChat !== "boolean") {
        throw failed(
          "the extension's restoreBegin answer has no indexPerChat: update the extension",
        );
      }
      indexPerChat = begin.indexPerChat;
      writing = true;
      for (const [n, entry] of this.entries.entries()) {
        this.signal?.throwIfAborted();
        if (n > 0 && n % 250 === 0) this.options.log?.(`${n} of ${this.entries.length} chats`);
        await this.restoreChat(entry, indexPerChat, sent);
      }
      ok = true;
    } catch (err) {
      const ended = toExitError(err, this.signal);
      throw writing ? withRerun(ended) : ended;
    } finally {
      try {
        finished = await this.finish(!indexPerChat, ok);
      } catch (err) {
        // Only a run that went well can get here: after a failure the finish is a courtesy
        closeFailure = withRerun(toExitError(err, this.signal));
      }
    }
    if (closeFailure) throw closeFailure;
    if (finished.indexError !== undefined) {
      throw failed(
        `every chat is restored, but the search index could not be brought up to date (${finished.indexError}). ` +
          "Search may miss chats until it is rebuilt: run `haevnDebug.rebuildIndex()` in the archive " +
          "page's console, or run the same command again (it replaces the chats again with the backup's copy)",
      );
    }
    return sent;
  }

  /** One chat: its media files first (so thumbnails are made from files that exist), then its record. */
  private async restoreChat(
    entry: IndexEntry,
    index: boolean,
    sent: { replaced: number; added: number; mediaFiles: number; bytes: number },
  ): Promise<void> {
    for (const media of entry.media) {
      await this.link.attempt(`media ${media.name} of chat ${entry.id}`, () =>
        this.upload(
          { action: "restoreMedia", chatId: entry.id, name: media.name, bytes: media.bytes },
          `${entry.mediaDir}/${media.name}`,
          media,
        ),
      );
      sent.mediaFiles += 1;
      sent.bytes += media.bytes;
    }
    const answer = await this.link.attempt(`chat ${entry.id}`, () =>
      this.upload<RestoreChatAnswer>(
        { action: "restoreChat", chatId: entry.id, index },
        entry.file,
        entry,
      ),
    );
    // A chat soft-deleted in the archive is replaced as a row but comes back as an addition: the
    // plan, the question and this count all say so
    if (answer.replaced && this.live.has(entry.id)) sent.replaced += 1;
    else sent.added += 1;
    sent.bytes += entry.bytes;
  }

  /**
   * Send one file of the backup as the body of `action`, and read it again as it goes: a file that
   * is not what `index.jsonl` says by the time it is sent (it was checked minutes ago) fails the run
   * rather than restore bytes nobody verified.
   */
  private async upload<T>(
    action: PipeActionBody,
    relative: string,
    expected: { bytes: number; sha256: string },
  ): Promise<T> {
    const hash = createHash("sha256");
    let seen = 0;
    // Why the file could not be sent, when it is the file's fault and not the transfer's
    let problem: string | undefined;
    const changed = `${relative} changed while it was being restored: it is not what index.jsonl says`;
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        seen += chunk.length;
        done(null, chunk);
      },
      flush(done) {
        // Shorter than announced: the daemon would wait for the rest until its own limit
        if (seen === expected.bytes) {
          done();
          return;
        }
        problem ??= changed;
        done(new Error(changed));
      },
    });
    const source =
      expected.bytes === 0
        ? Readable.from([])
        : fs.createReadStream(path.join(this.dir, relative), {
            start: 0,
            end: expected.bytes - 1,
          });
    source.on("error", (err: Error) => {
      problem ??= `${relative} could not be read: ${errorText(err)}`;
    });
    pipeline(source, tap).catch(() => undefined); // an error destroys `tap`, which `pipeIn` reports
    let answer: T;
    try {
      answer = await pipeIn<T>(this.endpoint, action, tap, expected.bytes, this.signal);
    } catch (err) {
      if (problem) throw failed(problem);
      throw err;
    }
    if (hash.digest("hex") !== expected.sha256) throw failed(changed);
    return answer;
  }

  /**
   * `restoreFinish`: the extension gives its lock back and rebuilds the index when asked or owed.
   * When the run ended well it must work (tried again like any call); when the run already failed it
   * is a courtesy, tried once without waiting for a connection: the extension closes an idle restore
   * by itself. No open session (`NO_SESSION`) is not an error here: it was closed already.
   */
  private async finish(rebuildIndex: boolean, ok: boolean): Promise<RestoreFinishInfo> {
    const call = (): Promise<RestoreFinishInfo> =>
      callFrame<RestoreFinishInfo>(this.endpoint, { action: "restoreFinish", rebuildIndex }).catch(
        (err: unknown) => {
          if (err instanceof DaemonCallError && err.code === "NO_SESSION") return {};
          throw err;
        },
      );
    if (ok) return this.link.withoutSignal().attempt("restoreFinish", call);
    try {
      return await call();
    } catch (err) {
      this.options.log?.(
        `could not close the restore (${errorText(err)}): the extension closes it by itself after a while`,
      );
      return {};
    }
  }
}

function withRerun(ended: ExitError): ExitError {
  return new ExitError(ended.exitCode, `${ended.message}. ${RERUN}`);
}

function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}
