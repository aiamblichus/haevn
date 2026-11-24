/**
 * Daemon HTTP client.
 *
 * Drop-in replacement for the old native/client.ts Unix-socket client.
 * All five CLI commands (`search`, `get`, `list`, `branches`, `export`) call
 * `daemonRequest<T>()` without knowing the transport; this module swaps the
 * Unix socket for a plain HTTP POST to the daemon's /api endpoint.
 *
 * Config is loaded from ~/.haevn/config.json (written by `haevn daemon` on
 * first run, or manually by the user).
 */

import type { CliRequestBody, CliResponse, HealthResponse, PipeActionBody } from "../types.js";
import { DEFAULT_DAEMON_PORT, loadConfig } from "./config.js";
import { PIPE_PROTOCOL, startDaemon } from "./server.js";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Retry schedule (delays in ms between attempts).
 *
 * The extension's service worker can go dormant and takes up to 30 s to
 * reconnect via its chrome.alarms keepalive.  The schedule below covers that
 * window with a fast first retry (transient blip) then progressively longer
 * waits, without making a hard failure take a full minute.
 *
 *   attempt 0 → immediate
 *   attempt 1 → wait 2 s   (fast retry for transient disconnects)
 *   attempt 2 → wait 10 s  (SW waking from short dormancy)
 *   attempt 3 → wait 20 s  (SW reconnecting after full 30 s alarm cycle)
 */
const RETRY_DELAYS_MS = [2_000, 10_000, 20_000];

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a request to the running HAEVN daemon and return the typed response
 * data.  Retries up to MAX_RETRIES times on connection failures so that a
 * brief service-worker dormancy window doesn't immediately fail the user.
 */
export async function daemonRequest<T>(
  request: CliRequestBody,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  return (await daemonRequestWithMeta<T>(request, timeout)).data;
}

/** A reply's data, and what the extension put beside it on the envelope. */
export interface DaemonReply<T> {
  data: T;
  /** A search only: more chats matched than the limit let through. Absent from an older extension. */
  hasMore?: boolean;
}

/**
 * `daemonRequest` for a command that reads the envelope as well as the data (`search`, for
 * `hasMore`). `data` is whatever the extension has always answered with, so a command that reads
 * only that works against an extension of any age.
 */
export async function daemonRequestWithMeta<T>(
  request: CliRequestBody,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<DaemonReply<T>> {
  const config = loadConfig();
  const port = config.port ?? DEFAULT_DAEMON_PORT;
  const apiKey = config.apiKey;

  if (!apiKey) {
    throw new Error(
      "No API key found in ~/.haevn/config.json.\n\n" +
        "Copy the key from the HAEVN extension Settings page and start the daemon:\n" +
        "  haevn daemon --api-key <key>",
    );
  }

  const url = `http://localhost:${port}/api`;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delayMs = RETRY_DELAYS_MS[attempt - 1];
      const delaySec = (delayMs / 1000).toFixed(0);
      process.stderr.write(
        `  Extension not connected — waiting ${delaySec}s for reconnect… (${attempt}/${RETRY_DELAYS_MS.length})\n`,
      );
      await sleep(delayMs);
    }

    try {
      return await attemptRequest<T>(url, apiKey, request, timeout);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on connection-level failures; propagate app/protocol errors.
      const isTransient =
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("fetch failed") ||
        lastError.message.includes("not connected") ||
        lastError.message.includes("503");

      if (!isTransient) throw lastError;
    }
  }

  const isDisconnected =
    lastError?.message.includes("not connected") || lastError?.message.includes("503");

  throw new Error(
    isDisconnected
      ? "The HAEVN extension did not reconnect in time.\n\n" +
          "Try opening the HAEVN Options page in Chrome to wake the extension,\n" +
          "then retry your command."
      : `${lastError?.message ?? "Daemon not available."}\n\n` +
          "Make sure the HAEVN daemon is running:\n" +
          "  haevn daemon --api-key <key>\n\n" +
          "And that Chrome is open with the HAEVN extension active.",
  );
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function attemptRequest<T>(
  url: string,
  apiKey: string,
  body: CliRequestBody,
  timeoutMs: number,
): Promise<DaemonReply<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg.includes("abort") ? "Request timed out." : msg);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 503) {
    throw new Error("503 — extension is not connected to the daemon");
  }

  const payload = (await res.json()) as CliResponse<T>;

  if (!payload.success) {
    throw new Error((payload as Extract<typeof payload, { success: false }>).error);
  }

  const { data, hasMore } = payload as Extract<typeof payload, { success: true }>;
  return { data, ...(hasMore === undefined ? {} : { hasMore }) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── The pipe, and a daemon of one's own (HVN-135) ────────────────────────────

/** Where a daemon is and the key it wants. `haevn backup` takes it from the config file. */
export interface DaemonEndpoint {
  port: number;
  apiKey: string;
}

/**
 * Why a call to the daemon failed, in the terms a command acts on:
 *
 *   unauthorized  the daemon refused the key
 *   not-connected no extension is connected to the daemon
 *   transport     the call or its bytes did not get through (a timeout, a cut stream, the extension
 *                 closing the pipe, a spent pipe id): the same call may work again
 *   extension     the extension answered with an error frame; `code` says which (BUSY, NOT_FOUND, …)
 *   unreachable   nothing answered at the daemon's port
 *   protocol      the daemon or the extension does not speak what this CLI expects
 */
export type DaemonFailureKind =
  | "unauthorized"
  | "not-connected"
  | "transport"
  | "extension"
  | "unreachable"
  | "protocol";

export class DaemonCallError extends Error {
  readonly kind: DaemonFailureKind;
  readonly code?: string;

  constructor(kind: DaemonFailureKind, message: string, code?: string) {
    super(message);
    this.name = "DaemonCallError";
    this.kind = kind;
    if (code !== undefined) this.code = code;
  }
}

function baseUrl(endpoint: Pick<DaemonEndpoint, "port">): string {
  return `http://127.0.0.1:${endpoint.port}`;
}

/**
 * `GET /health`: what the daemon on the port says, or null when nothing listens there. A listener
 * that is not a HAEVN daemon, or does not answer in time, is an error.
 */
export async function probeHealth(
  endpoint: Pick<DaemonEndpoint, "port">,
  signal?: AbortSignal,
): Promise<HealthResponse | null> {
  const timeout = AbortSignal.timeout(3_000);
  let res: Response;
  try {
    res = await fetch(`${baseUrl(endpoint)}/health`, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if ((err as { cause?: { code?: string } }).cause?.code === "ECONNREFUSED") return null;
    throw new DaemonCallError(
      "unreachable",
      `nothing sensible answered at port ${endpoint.port}: ${errorText(err)}`,
    );
  }
  let body: Partial<HealthResponse> | null = null;
  try {
    body = (await res.json()) as Partial<HealthResponse>;
  } catch {
    // not JSON: handled below
  }
  if (!body || body.ok !== true || typeof body.extensionConnected !== "boolean") {
    throw new DaemonCallError(
      "protocol",
      `port ${endpoint.port} is held by something that is not the HAEVN daemon`,
    );
  }
  return body as HealthResponse;
}

/** A daemon this process can talk to, and what it must clean up. */
export interface DaemonSession {
  endpoint: DaemonEndpoint;
  /** This process started the daemon and stops it in `stop`. */
  ownsDaemon: boolean;
  /** An extension offered another API key to the daemon this process started. */
  authFailed(): boolean;
  stop(): Promise<void>;
}

/**
 * The daemon on the endpoint's port. When nothing listens there, one is started in this process (it
 * stops with `stop`); when a daemon listens that predates the pipe, that is an error to say plainly.
 */
export async function openDaemon(endpoint: DaemonEndpoint): Promise<DaemonSession> {
  const standing = await probeHealth(endpoint);
  if (standing) {
    if (standing.pipe !== PIPE_PROTOCOL) {
      throw new DaemonCallError(
        "protocol",
        `the daemon on port ${endpoint.port} does not speak the pipe protocol ${PIPE_PROTOCOL} ` +
          `(it reports ${standing.pipe ?? "none"}): restart it with \`haevn daemon\``,
      );
    }
    return { endpoint, ownsDaemon: false, authFailed: () => false, stop: async () => {} };
  }

  let authFailure = false;
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon(endpoint, {
      onAuthFailure: () => {
        authFailure = true;
      },
    });
  } catch (err) {
    throw new DaemonCallError(
      "unreachable",
      `could not start a daemon on port ${endpoint.port}: ${errorText(err)}`,
    );
  }
  return {
    endpoint: { ...endpoint, port: daemon.port },
    ownsDaemon: true,
    authFailed: () => authFailure,
    // A stuck socket must not keep a finished run alive.
    stop: () => Promise.race([daemon.stop(), sleep(3_000)]),
  };
}

/** The most a frame is given: the daemon's own limit is 30 s, and this leaves it room to answer. */
const FRAME_TIMEOUT_MS = 35_000;

/**
 * One `/api` call, no retry: the extension's data, or a `DaemonCallError` that says what kind of
 * failure it was. (`daemonRequest` is the retrying call the other commands use.)
 */
export async function callFrame<T>(
  endpoint: DaemonEndpoint,
  request: CliRequestBody,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(FRAME_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${baseUrl(endpoint)}/api`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(request),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    throw fetchFailure(err, signal);
  }
  if (!res.ok) throw await failureOf(res);
  const payload = (await res.json()) as CliResponse<T>;
  if (!payload.success) throw frameFailure(payload.error, payload.code);
  return payload.data;
}

/** The bytes of a `/pipe/out` answer and the length the extension declared for them. */
export interface PipeBody {
  /** The Content-Length; null when the answer has none (the daemon always sends one). */
  length: number | null;
  body: ReadableStream<Uint8Array>;
}

/**
 * Open `POST /pipe/out`: the extension sends the bytes of `action` (a record or a media file) to the
 * daemon and the daemon passes them on. No time limit here; the daemon's own (120 s to the first
 * byte, 30 s without one) ends a transfer that does not move. `signal` ends it from outside.
 */
export async function pipeOut(
  endpoint: DaemonEndpoint,
  action: PipeActionBody,
  signal?: AbortSignal,
): Promise<PipeBody> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl(endpoint)}/pipe/out`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` },
      body: JSON.stringify(action),
      signal,
    });
  } catch (err) {
    throw fetchFailure(err, signal);
  }
  if (!res.ok || !res.body) throw await failureOf(res);
  const declared = res.headers.get("content-length");
  return {
    length: declared !== null && /^\d+$/.test(declared) ? Number(declared) : null,
    body: res.body,
  };
}

/** An error frame from the extension. A pipe the extension could not use is the transport's fault. */
function frameFailure(message: string, code: string | undefined): DaemonCallError {
  return new DaemonCallError(code === "PIPE_FAILED" ? "transport" : "extension", message, code);
}

function fetchFailure(err: unknown, signal: AbortSignal | undefined): Error {
  if (signal?.aborted) return err instanceof Error ? err : new Error(String(err));
  if (err instanceof Error && err.name === "TimeoutError") {
    return new DaemonCallError("transport", "the daemon did not answer in time");
  }
  // A pooled connection the daemon had closed (its 5 s keep-alive) fails the request that reuses
  // it; a new connection works.
  const code = (err as { cause?: { code?: string } }).cause?.code ?? "";
  if (["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"].includes(code)) {
    return new DaemonCallError("transport", `the connection to the daemon was reset (${code})`);
  }
  return new DaemonCallError("unreachable", `the daemon did not answer: ${errorText(err)}`);
}

/** What a non-200 answer from the daemon means: its own refusal, or the extension's error frame. */
async function failureOf(res: Response): Promise<DaemonCallError> {
  type Answer = { success?: boolean; error?: unknown; code?: unknown };
  let body: Answer | null = null;
  try {
    body = (await res.json()) as Answer | null;
  } catch {
    // no JSON body: the status says what it can
  }
  const message =
    typeof body?.error === "string" ? body.error : `the daemon answered ${res.status}`;
  if (res.status === 401) {
    return new DaemonCallError("unauthorized", "the daemon refused the API key");
  }
  if (body?.success === false) {
    return frameFailure(message, typeof body.code === "string" ? body.code : undefined);
  }
  if (res.status === 503) return new DaemonCallError("not-connected", message);
  if (res.status === 499 || res.status === 502 || res.status === 504) {
    return new DaemonCallError("transport", message);
  }
  return new DaemonCallError("protocol", `${message} (HTTP ${res.status})`);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
