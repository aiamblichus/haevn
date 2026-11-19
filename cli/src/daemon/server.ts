/**
 * HAEVN daemon server.
 *
 * Runs a single HTTP server that handles two types of traffic:
 *
 *   POST /api          ← CLI commands (JSON request/response)
 *   GET  /ws  (upgrade) ← Extension WebSocket connection
 *   GET  /health        ← Liveness probe
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
 *
 * Both sides share the same API key, which the user copies from the HAEVN
 * extension's Settings page.
 */

import * as http from "node:http";
import { type WebSocket, WebSocketServer } from "ws";
import type { CliRequestBody, CliResponse } from "../types.js";
import type { DaemonConfig } from "./config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (response: CliResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
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

export async function startDaemon(config: DaemonConfig): Promise<DaemonServer> {
  const { port, apiKey } = config;

  /** The single authenticated extension WebSocket, if connected. */
  let extensionSocket: WebSocket | null = null;

  /** In-flight requests waiting for a response from the extension. */
  const pending = new Map<string, PendingRequest>();

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
      json(res, 200, {
        ok: true,
        extensionConnected: extensionSocket !== null,
      });
      return;
    }

    if (req.url === "/api" && req.method === "POST") {
      handleApiRequest(req, res);
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
