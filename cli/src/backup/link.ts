/**
 * Reaching the extension, for the commands that drive it one request at a time (`haevn backup`,
 * `haevn restore`; architecture/backup-restore, "Reaching the extension").
 *
 * The two commands share everything that is about the connection and nothing that is about the
 * archive: a daemon of one's own when none listens, the wait for the extension to connect (75 when
 * it does not), the check that both sides speak the same protocol, the listing of the live chats,
 * and `attempt`, the one place that decides which failure of a call is tried again, which defers
 * the run (75) and which fails it (1).
 */

import {
  callFrame,
  DaemonCallError,
  type DaemonEndpoint,
  type DaemonSession,
  openDaemon,
  probeHealth,
} from "../daemon/client.js";
import type { BackupInfo, BackupListedChat, BackupListPage } from "../types.js";
import { deferred, ExitError, failed } from "../utils/exit.js";

/** The backup protocol this CLI speaks (`BACKUP_PROTOCOL` in `src/services/backup/format.ts`). */
export const BACKUP_PROTOCOL = 1;

/**
 * The pause before each new try of an item whose transfer did not get through: a cut stream, a
 * timeout, a pipe the extension could not use (Chrome re-sends a POST on a stale keep-alive
 * connection, and the second try finds the pipe id spent: a 404 that a fresh pipe id cures).
 * Two retries, so three tries in all: enough to ride out the one-off races, few enough that an item
 * that can never get through fails the run in minutes, not hours.
 */
export const RETRY_DELAYS_MS = [500, 2_000];

const PAGE_SIZE = 100;

export interface LinkOptions {
  /** How long to wait for the extension to connect, or to come back, before 75. */
  waitMs: number;
  /** Ends the run: it fails as interrupted. */
  signal?: AbortSignal;
  /** For tests: the polling interval, the retry pauses and the page size. */
  timing?: { pollMs?: number; retryDelaysMs?: number[]; pageSize?: number };
}

/** A daemon this process can talk to, and the rules for talking to the extension through it. */
export class ExtensionLink {
  private readonly retryDelays: number[];
  private readonly pollMs: number;
  private readonly pageSize: number;
  private readonly signal?: AbortSignal;
  readonly endpoint: DaemonEndpoint;

  constructor(
    private readonly options: LinkOptions,
    private readonly session: DaemonSession,
  ) {
    this.retryDelays = options.timing?.retryDelaysMs ?? RETRY_DELAYS_MS;
    this.pollMs = options.timing?.pollMs ?? 1_000;
    this.pageSize = options.timing?.pageSize ?? PAGE_SIZE;
    this.signal = options.signal;
    this.endpoint = session.endpoint;
  }

  /** The daemon on the endpoint's port, or one started in this process (`stop` ends it). */
  static async open(endpoint: DaemonEndpoint, options: LinkOptions): Promise<ExtensionLink> {
    try {
      return new ExtensionLink(options, await openDaemon(endpoint));
    } catch (err) {
      if (err instanceof DaemonCallError) throw failed(err.message);
      throw err;
    }
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  /**
   * The same daemon without the run's signal: for what must still happen after the run was
   * interrupted (a restore gives its lock back).
   */
  withoutSignal(): ExtensionLink {
    return new ExtensionLink({ ...this.options, signal: undefined }, this.session);
  }

  /** Wait for the extension, then check that it speaks the protocol this CLI speaks. */
  async connect(): Promise<BackupInfo> {
    const waitSeconds = Math.round(this.options.waitMs / 1000);
    await this.waitForExtension(
      `no extension connected within ${waitSeconds} s (Chrome is closed, the CLI bridge is off, or the extension is reloading)`,
    );
    const info = await this.attempt("backupInfo", () =>
      callFrame<BackupInfo>(this.endpoint, { action: "backupInfo" }, this.signal),
    );
    if (info.protocol !== BACKUP_PROTOCOL) {
      throw failed(
        `the extension speaks backup protocol ${info.protocol} and this CLI speaks ${BACKUP_PROTOCOL}: ` +
          `update the ${info.protocol > BACKUP_PROTOCOL ? "CLI" : "extension"}`,
      );
    }
    return info;
  }

  /** Every live chat, page by page, in the extension's key order. */
  async listChats(): Promise<BackupListedChat[]> {
    const chats: BackupListedChat[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.attempt("the chat list", () =>
        callFrame<BackupListPage>(
          this.endpoint,
          { action: "backupList", limit: this.pageSize, ...(after === undefined ? {} : { after }) },
          this.signal,
        ),
      );
      chats.push(...page.chats);
      if (page.next === undefined) return chats;
      if (page.next === after)
        throw failed("the chat list does not advance: the extension repeats a page");
      after = page.next;
    }
  }

  /**
   * One call, tried again when the transfer did not get through. What the unattended runner must
   * know goes out as `deferred` (BUSY; no extension, now or after the connection was lost) or
   * `failed` (everything else: a request the extension refuses (BAD_REQUEST, NO_SESSION, …) is
   * never tried again). A chat the extension no longer has comes back as null when the caller says
   * a missing item is fine.
   */
  async attempt<T>(
    what: string,
    op: () => Promise<T>,
    flags: { missingIsOk: true },
  ): Promise<T | null>;
  async attempt<T>(what: string, op: () => Promise<T>): Promise<T>;
  async attempt<T>(
    what: string,
    op: () => Promise<T>,
    flags: { missingIsOk?: boolean } = {},
  ): Promise<T | null> {
    for (let tries = 0; ; tries++) {
      this.signal?.throwIfAborted();
      try {
        return await op();
      } catch (err) {
        if (!(err instanceof DaemonCallError)) throw err;
        switch (err.kind) {
          case "extension":
            if (err.code === "BUSY") throw deferred(`the extension is busy: ${err.message}`);
            if (err.code === "UNKNOWN_ACTION") {
              throw failed(
                `the extension does not know ${what}: it predates backup and restore, update the extension`,
              );
            }
            if (err.code === "NOT_FOUND" && flags.missingIsOk) return null;
            throw failed(
              `${what}: the extension answered ${err.code ?? "an error"}: ${err.message}`,
            );
          case "not-connected":
          case "transport":
            // The connection may be what broke: if so, wait for it before another try.
            await this.waitForExtension(
              `the connection to the extension was lost and did not return within ${Math.round(this.options.waitMs / 1000)} s`,
            );
            if (tries >= this.retryDelays.length) {
              throw failed(`${what}: ${err.message} (${tries + 1} tries)`);
            }
            await sleep(this.retryDelays[tries], this.signal);
            continue;
          case "unauthorized":
            throw failed(
              `${what}: the daemon refused the API key: check the key in ~/.haevn/config.json`,
            );
          default:
            throw failed(`${what}: ${err.message}`);
        }
      }
    }
  }

  /**
   * Poll `/health` until the extension is connected: at once if it is. When none is within
   * `--wait`, the run ends: 1 if a socket offered a wrong API key meanwhile (a wrong key never mends
   * by waiting), else 75 with `timeout`. A wrong-key socket does not matter while a good extension
   * is connected: any page or other extension can dial the daemon's port with a key of its own.
   */
  async waitForExtension(timeout: string): Promise<void> {
    const deadline = Date.now() + this.options.waitMs;
    for (;;) {
      const health = await probeHealth(this.endpoint, this.signal);
      if (!health) throw failed(`the daemon on port ${this.endpoint.port} stopped answering`);
      if (health.extensionConnected) return;
      const left = deadline - Date.now();
      if (left <= 0) {
        if (this.session.authFailed()) {
          throw failed(
            "an extension connected with a different API key than the one in ~/.haevn/config.json: set the same key in both",
          );
        }
        throw deferred(timeout);
      }
      await sleep(Math.min(this.pollMs, left), this.signal);
    }
  }
}

// ─── Small things ─────────────────────────────────────────────────────────────

/** What ended a run, in the terms of the exit table: anything not already one is a failure. */
export function toExitError(err: unknown, signal?: AbortSignal): ExitError {
  if (err instanceof ExitError) return err;
  if (signal?.aborted) return failed("interrupted");
  if (err instanceof DaemonCallError) return failed(err.message);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) {
    return failed(`disk error (${code}): ${errorText(err)}`);
  }
  return failed(errorText(err));
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
