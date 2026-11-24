/**
 * HAEVN daemon server.
 *
 * Runs a single HTTP server that handles these kinds of traffic:
 *
 *   POST /api            ← CLI commands (JSON request/response)
 *   POST /pipe/out       ← CLI commands that read bulk bytes from the extension
 *   POST /pipe/in        ← CLI commands that send bulk bytes to the extension
 *   POST|GET /pipe/<id>  ← the extension's side of a pipe (see below)
 *   GET  /ws  (upgrade)  ← Extension WebSocket connection
 *   GET  /health         ← Liveness probe
 *
 * Architecture:
 *
 *   CLI client ──HTTP POST /api──▶ daemon ──WS──▶ extension
 *                                  daemon ◀──WS──  extension
 *   CLI client ◀──HTTP response── daemon
 *
 * The daemon is the stable entity: it keeps running when the extension's
 * service worker is dormant, queuing requests (as pending promises) until
 * the extension reconnects.
 *
 * Auth:
 *   - Extension → Daemon: first WS message must be { "type": "auth", "apiKey": "…" }
 *   - CLI → Daemon: Authorization: Bearer <apiKey> header on every HTTP request
 *   - Extension → Daemon pipe requests: the same Bearer header
 *
 * Both sides share the same API key, which the user copies from the HAEVN
 * extension's Settings page.
 *
 * The pipe (HVN-133). A frame is one JSON message that must arrive within 30 s, which is no way to
 * move a 100 MB chat record or a 5 GB archive. Bulk bytes go by plain HTTP through the daemon
 * instead, and the daemon only copies them, chunk by chunk, with backpressure, never to disk:
 *
 *   POST /pipe/out  CLI ── { action, … } ──▶ daemon ── frame + pipeId ──▶ extension
 *                   CLI ◀── the bytes ── daemon ◀── POST /pipe/<pipeId> ── extension
 *   POST /pipe/in   CLI ── X-Haevn-Request: { action, … } + the body ──▶ daemon ── frame + pipeId ──▶ extension
 *                   CLI ◀── the extension's frame ── daemon ◀── GET /pipe/<pipeId> (the body) ── extension
 *
 * A `pipeId` is 128 random bits and works for one request.
 */

import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { Readable } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import type {
  CliRequestBody,
  CliResponse,
  DaemonErrorBody,
  HealthResponse,
  PipeActionBody,
  PipeForwardedRequest,
  PipeId,
} from "../types.js";
import type { DaemonConfig } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (response: CliResponse) => void;
  reject: (err: Error) => void;
  /** Absent for a pipe request, which keeps its own timers (they change as bytes move). */
  timer?: NodeJS.Timeout;
}

/** One pipe request, from the CLI's call to its end. */
interface PipeSession {
  pipeId: PipeId;
  /** The id of the frame forwarded to the extension. */
  id: string;
  direction: "out" | "in";
  cliReq: http.IncomingMessage;
  cliRes: http.ServerResponse;
  /** `in`: the length of the body the CLI sends. */
  cliLength: number;
  /** The extension has used the pipeId. */
  claimed: boolean;
  extReq?: http.IncomingMessage;
  extRes?: http.ServerResponse;
  /** `in`: the extension has read the whole body. */
  streamDone: boolean;
  /** `in`: the extension's successful answer, held until the body has been read. */
  frame?: CliResponse;
  timer?: NodeJS.Timeout;
  /** The running timer is the "no byte for a while" one, which each chunk postpones. */
  timerIsIdle: boolean;
  /** Settled one way or the other; everything after this is ignored. */
  done: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * `health` opens a tab on each provider's site and takes minutes, not seconds: the extension ends
 * the run within 240 s, and this leaves it room to answer.
 */
export const HEALTH_REQUEST_TIMEOUT_MS = 270_000;

export function timeoutFor(body: CliRequestBody | null | undefined): number {
  // `JSON.parse("null")` is valid JSON: a body that is not an object gets the default
  return body?.action === "health" ? HEALTH_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

/** The pipe protocol this daemon speaks; `GET /health` reports it so a client can tell an older daemon. */
export const PIPE_PROTOCOL = 1;

/**
 * A pipe action reads or writes the archive, which takes longer to start than a frame does: 120 s
 * from the CLI's call to the first byte moving (and, for an upload, to the answer once the last
 * byte is in). After that a transfer that moves no byte for 30 s has stalled.
 */
export const PIPE_FIRST_BYTE_TIMEOUT_MS = 120_000;
export const PIPE_IDLE_TIMEOUT_MS = 30_000;

/** The header that carries the action of a `/pipe/in` call, whose body is the file. */
export const PIPE_REQUEST_HEADER = "x-haevn-request";

export interface DaemonOptions {
  /** For tests: the two limits above. */
  pipeFirstByteTimeoutMs?: number;
  pipeIdleTimeoutMs?: number;
}

// ─── Counter for request IDs ──────────────────────────────────────────────────

let _reqCounter = 0;

function generateId(): string {
  return `${process.pid}-${Date.now()}-${++_reqCounter}`;
}

// ─── Server factory ───────────────────────────────────────────────────────────

export interface DaemonServer {
  /** The port actually bound; differs from the configured one when that was 0. */
  port: number;
  stop(): Promise<void>;
}

export async function startDaemon(
  config: DaemonConfig,
  options: DaemonOptions = {},
): Promise<DaemonServer> {
  const { port, apiKey } = config;
  const firstByteMs = options.pipeFirstByteTimeoutMs ?? PIPE_FIRST_BYTE_TIMEOUT_MS;
  const idleMs = options.pipeIdleTimeoutMs ?? PIPE_IDLE_TIMEOUT_MS;

  /** The single authenticated extension WebSocket, if connected. */
  let extensionSocket: WebSocket | null = null;

  /** In-flight requests waiting for a response from the extension. */
  const pending = new Map<string, PendingRequest>();

  /** Pipe requests whose pipeId the extension has not used yet. A claim removes the entry. */
  const pipes = new Map<PipeId, PipeSession>();

  /** Every live pipe request, claimed or not, so that a shutdown can end them. */
  const sessions = new Set<PipeSession>();

  /** Reject every in-flight request. Only the extension socket's requests are ever pending. */
  function failPending(message: string): void {
    for (const [id, req] of pending) {
      pending.delete(id);
      clearTimeout(req.timer);
      req.reject(new Error(message));
    }
  }

  // ── HTTP server ─────────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      const health: HealthResponse = {
        ok: true,
        extensionConnected: extensionSocket !== null,
        pipe: PIPE_PROTOCOL,
      };
      json(res, 200, health);
      return;
    }

    if (req.url === "/api" && req.method === "POST") {
      handleApiRequest(req, res);
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    if (path === "/pipe/out" && req.method === "POST") {
      handlePipeOpen(req, res, "out");
      return;
    }
    if (path === "/pipe/in" && req.method === "POST") {
      handlePipeOpen(req, res, "in");
      return;
    }
    const claim = /^\/pipe\/([0-9a-f]{32})$/.exec(path);
    if (claim && (req.method === "POST" || req.method === "GET")) {
      handlePipeClaim(req, res, claim[1]);
      return;
    }

    json(res, 404, { ok: false, error: "Not found" });
  });

  // ── WebSocket server ────────────────────────────────────────────────────────

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let authenticated = false;

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        ws.close(1003, "Invalid JSON");
        return;
      }

      // ── Auth handshake ──
      if (!authenticated) {
        if (msg.type !== "auth" || msg.apiKey !== apiKey) {
          ws.send(JSON.stringify({ type: "authError", message: "Invalid API key" }));
          ws.close(4001, "Unauthorized");
          return;
        }
        authenticated = true;
        if (extensionSocket && extensionSocket !== ws) {
          // A newer extension replaces the old one. Nobody can answer the old socket's
          // requests now, so fail them here, once, and close the old socket with a reason;
          // its close event then finds it is no longer the extension's socket.
          const replaced = extensionSocket;
          failPending("Extension reconnected while processing your request.");
          replaced.close(4002, "Replaced by a newer extension connection");
        }
        extensionSocket = ws;
        ws.send(JSON.stringify({ type: "authOk" }));
        process.stderr.write("[haevn daemon] Extension connected\n");
        return;
      }

      // ── Response from extension ──
      if (msg.type === "ping") return; // ignore keepalives

      const id = msg.id as string | undefined;
      if (!id) return;

      const pending_req = pending.get(id);
      if (!pending_req) return; // already timed out

      pending.delete(id);
      clearTimeout(pending_req.timer);
      pending_req.resolve(msg as unknown as CliResponse);
    });

    ws.on("close", () => {
      // Only the extension's own socket owns the pending requests. A stray socket that
      // opens and closes, or a replaced one, must not fail a request the extension is answering.
      if (extensionSocket !== ws) return;
      extensionSocket = null;
      process.stderr.write("[haevn daemon] Extension disconnected\n");
      failPending("Extension disconnected while processing your request.");
    });

    ws.on("error", () => {
      // onclose fires after onerror — handled there
    });
  });

  // ── HTTP request handler ────────────────────────────────────────────────────

  async function handleApiRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Auth
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${apiKey}`) {
      json(res, 401, { ok: false, error: "Unauthorized" });
      return;
    }

    // Parse body
    let body: CliRequestBody;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as CliRequestBody;
    } catch {
      json(res, 400, { ok: false, error: "Invalid JSON body" });
      return;
    }

    // Check extension is connected
    if (!extensionSocket || extensionSocket.readyState !== 1 /* OPEN */) {
      json(res, 503, {
        ok: false,
        error:
          "Extension is not connected.\n" +
          "Open Chrome with the HAEVN extension active, then retry.",
      });
      return;
    }

    // Forward to extension and wait for response
    const id = generateId();
    const request = { id, ...body };

    let response: CliResponse;
    try {
      response = await new Promise<CliResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Request timed out. The extension may be busy."));
        }, timeoutFor(body));

        pending.set(id, { resolve, reject, timer });
        extensionSocket!.send(JSON.stringify(request));
      });
    } catch (err) {
      json(res, 504, {
        ok: false,
        error: err instanceof Error ? err.message : "Gateway timeout",
      });
      return;
    }

    json(res, response.success ? 200 : 422, response);
  }

  // ── The pipe ────────────────────────────────────────────────────────────────

  function authorized(req: http.IncomingMessage): boolean {
    return (req.headers.authorization ?? "") === `Bearer ${apiKey}`;
  }

  /** The daemon's own error answer. */
  function refuse(res: http.ServerResponse, status: number, error: string): void {
    const body: DaemonErrorBody = { ok: false, error };
    json(res, status, body);
  }

  function arm(s: PipeSession, ms: number, idle: boolean, message: string): void {
    clearTimeout(s.timer);
    s.timerIsIdle = idle;
    s.timer = setTimeout(() => fail(s, 504, message), ms);
  }

  function disarm(s: PipeSession): void {
    clearTimeout(s.timer);
    s.timer = undefined;
  }

  /** A byte moved: the first one starts the idle clock, the ones after it postpone it. */
  function touch(s: PipeSession, message: string): void {
    if (s.timerIsIdle && s.timer) s.timer.refresh();
    else arm(s, idleMs, true, message);
  }

  /** Forget the session. After this nothing it holds can be reached through the maps. */
  function release(s: PipeSession): void {
    s.done = true;
    disarm(s);
    pending.delete(s.id);
    pipes.delete(s.pipeId);
    sessions.delete(s);
  }

  /**
   * End the session with an error. Before the first byte the CLI gets a JSON answer; after it the
   * response is destroyed, so the CLI sees a body shorter than its Content-Length. The
   * extension's own connection, if it has one, is cut.
   */
  function fail(s: PipeSession, status: number, message: string, frame?: CliResponse): void {
    if (s.done) return;
    release(s);
    s.extReq?.destroy();
    s.extRes?.destroy();
    // An upload still on its way is read and dropped, so the CLI is not left blocked on a write
    // and can read the answer; the daemon holds none of it.
    s.cliReq.resume();
    const res = s.cliRes;
    if (res.destroyed) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (frame) json(res, status, frame);
    else refuse(res, status, message);
  }

  /** The extension's frame for a pipe action. */
  function onFrame(s: PipeSession, frame: CliResponse): void {
    if (s.done) return;
    if (!frame.success) {
      // Its ordinary error frame. Before the first byte that is the CLI's answer; later it ends
      // the stream (and `fail` destroys the response).
      fail(s, 422, frame.error, frame);
      return;
    }
    if (!s.claimed) {
      fail(s, 502, "The extension answered without using the pipe. No bytes were moved.");
      return;
    }
    if (s.direction === "in") {
      if (s.streamDone) finishUpload(s, frame);
      else s.frame = frame; // the body is still on its way; answer when it has arrived
    }
    // `out`: the bytes are the answer; this frame's data is only a trailer, and the stream ends
    // the response when the last byte has been copied.
  }

  function finishUpload(s: PipeSession, frame: CliResponse): void {
    release(s);
    json(s.cliRes, frame.success ? 200 : 422, frame);
  }

  /** `POST /pipe/out` and `POST /pipe/in`: the CLI opens a pipe. */
  async function handlePipeOpen(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    direction: "out" | "in",
  ): Promise<void> {
    if (!authorized(req)) {
      refuse(res, 401, "Unauthorized");
      return;
    }

    let body: PipeActionBody;
    let cliLength = 0;
    try {
      if (direction === "out") {
        body = JSON.parse(await readBody(req)) as PipeActionBody;
      } else {
        const header = req.headers[PIPE_REQUEST_HEADER];
        body = JSON.parse(typeof header === "string" ? header : "") as PipeActionBody;
      }
      if (typeof body?.action !== "string") throw new Error("no action");
    } catch {
      refuse(
        res,
        400,
        direction === "out"
          ? "Invalid JSON body"
          : `Invalid or missing ${PIPE_REQUEST_HEADER} header: it carries the action as JSON`,
      );
      return;
    }

    if (direction === "in") {
      const length = contentLength(req);
      if (length === null) {
        refuse(res, 411, "A pipe upload needs a Content-Length");
        return;
      }
      cliLength = length;
    }

    if (!extensionSocket || extensionSocket.readyState !== 1 /* OPEN */) {
      refuse(
        res,
        503,
        "Extension is not connected.\nOpen Chrome with the HAEVN extension active, then retry.",
      );
      return;
    }

    const s: PipeSession = {
      pipeId: randomBytes(16).toString("hex"),
      id: generateId(),
      direction,
      cliReq: req,
      cliRes: res,
      cliLength,
      claimed: false,
      streamDone: false,
      timerIsIdle: false,
      done: false,
    };
    sessions.add(s);
    pipes.set(s.pipeId, s);
    pending.set(s.id, {
      resolve: (frame) => onFrame(s, frame),
      reject: (err) => fail(s, 504, err.message),
    });
    // The CLI went away before the end: nobody is left to answer, and the extension's side is cut.
    res.on("close", () => fail(s, 499, "The client closed the connection."));
    arm(s, firstByteMs, false, "The transfer did not start in time. The extension may be busy.");

    const forwarded: PipeForwardedRequest = { ...body, id: s.id, pipeId: s.pipeId };
    extensionSocket.send(JSON.stringify(forwarded));
  }

  /** `POST /pipe/<id>` (out) and `GET /pipe/<id>` (in): the extension uses its pipeId. */
  function handlePipeClaim(req: http.IncomingMessage, res: http.ServerResponse, id: PipeId): void {
    if (!authorized(req)) {
      refuse(res, 401, "Unauthorized");
      return;
    }
    const s = pipes.get(id);
    if (!s || req.method !== (s.direction === "out" ? "POST" : "GET")) {
      refuse(res, 404, "No such pipe, or it has been used already");
      return;
    }
    pipes.delete(id); // a pipeId works once
    s.claimed = true;
    s.extReq = req;
    s.extRes = res;
    // The extension went away before the end.
    res.on("close", () => {
      if (!res.writableFinished) fail(s, 502, "The extension closed the pipe.");
    });

    if (s.direction === "out") {
      const length = contentLength(req);
      if (length === null) {
        fail(s, 502, "The extension sent bytes without a Content-Length.");
        return;
      }
      relay(s, req, s.cliRes, length, { sender: "the extension", reader: "the CLI" }, () => {
        release(s);
        json(res, 200, { ok: true });
      });
    } else {
      relay(s, s.cliReq, res, s.cliLength, { sender: "the CLI", reader: "the extension" }, () => {
        s.streamDone = true;
        if (s.frame) finishUpload(s, s.frame);
        else
          arm(
            s,
            firstByteMs,
            false,
            "The extension did not answer after the upload. It may be busy.",
          );
      });
    }
  }

  /**
   * Copy `length` bytes from `src` to `dst`, one chunk at a time. The response head (with the
   * Content-Length) goes out with the first chunk, so a failure before it can still be an error
   * answer. Backpressure: when `dst` is full `src` is paused, and the idle clock now waits for
   * `dst` to drain, so a reader that is alive but does not read is cut like a writer that stalls.
   * `parties` names who sends (`src`) and who reads (`dst`), for the message of a stall.
   */
  function relay(
    s: PipeSession,
    src: Readable,
    dst: http.ServerResponse,
    length: number,
    parties: { sender: string; reader: string },
    onDone: () => void,
  ): void {
    const senderStalled = `The transfer stalled: ${parties.sender} stopped sending data.`;
    const readerStalled = `The transfer stalled: ${parties.reader} stopped reading data.`;
    const head = (): void => {
      dst.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": length,
      });
    };

    src.on("data", (chunk: Buffer) => {
      if (s.done) return;
      if (!dst.headersSent) head();
      if (dst.write(chunk)) {
        touch(s, senderStalled);
      } else {
        src.pause();
        arm(s, idleMs, true, readerStalled);
        dst.once("drain", () => {
          if (s.done) return;
          src.resume();
          arm(s, idleMs, true, senderStalled);
        });
      }
    });

    // A body cut short never ends here: Node's parser ends the request with an error and closes
    // its socket, and the `close` handlers of both responses (where the pipe is claimed and
    // opened) fail the session. So `end` means all `length` bytes came.
    src.on("end", () => {
      if (s.done) return;
      if (!dst.headersSent) head();
      dst.end();
      onDone();
    });
  }

  // ── Start listening ─────────────────────────────────────────────────────────

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  process.stderr.write(`[haevn daemon] Listening on http://localhost:${boundPort}\n`);

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  async function stop(): Promise<void> {
    process.stderr.write("[haevn daemon] Shutting down…\n");
    for (const s of [...sessions]) fail(s, 503, "The daemon is shutting down.");
    extensionSocket?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { port: boundPort, stop };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** The request's Content-Length as a count of bytes, or null when it has none or it is not one. */
function contentLength(req: http.IncomingMessage): number | null {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return null;
  const length = Number(raw);
  return Number.isSafeInteger(length) ? length : null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
