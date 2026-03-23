/**
 * HAEVN daemon – the long-lived bridge between Chrome Native Messaging and CLI clients.
 *
 * Chrome spawns this process (via the native messaging host manifest) when the
 * extension calls `chrome.runtime.connectNative("com.haevn.cli")`.
 *
 * Architecture:
 *
 *   ┌──────────────────────────────────────────────────────────────────┐
 *   │  haevn daemon                                                    │
 *   │                                                                  │
 *   │  Unix socket / named pipe          NM stdio                      │
 *   │  ◀── CLI clients connect here      stdout ──▶ Chrome extension   │
 *   │  ──▶ responses sent here           stdin  ◀── Chrome extension   │
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * Message flow for a CLI command (e.g. `haevn search "query"`):
 *   1. CLI client connects to the socket, sends NDJSON request with a unique id.
 *   2. Daemon receives request, stores (id → socket) in pending map.
 *   3. Daemon writes request to NM stdout → Chrome extension receives it.
 *   4. Extension processes the request, writes response to NM port.
 *   5. Chrome pipes response to daemon's stdin.
 *   6. Daemon reads response from stdin, looks up pending map by id.
 *   7. Daemon writes response as NDJSON back to the original CLI client socket.
 *   8. CLI client reads response and exits.
 *
 * Keepalive:
 *   The extension sends periodic `{action:"ping"}` pings via port.postMessage()
 *   to keep the MV3 service worker alive.  These arrive on the daemon's stdin and
 *   are silently discarded (they have no `id` field).
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import type { CliRequest, CliResponse } from "../types";
import { readNativeMessage, SOCKET_PATH, writeNativeMessage } from "./protocol";

export async function runDaemon(): Promise<void> {
  // Ensure the socket directory exists.
  const socketDir = path.dirname(SOCKET_PATH);
  fs.mkdirSync(socketDir, { recursive: true });

  // Remove a stale socket from a previous run.
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {
    // No stale socket – that's fine.
  }

  /**
   * Pending requests waiting for a response from the extension.
   * Maps request id → the socket client that originated it.
   */
  const pending = new Map<string, net.Socket>();

  /** Whether the NM connection to Chrome is still alive. */
  let nmAlive = true;

  // ── Unix socket / named pipe server ────────────────────────────────────────
  // CLI commands connect here to send requests and receive responses.

  const server = net.createServer((client) => {
    let buf = "";

    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");

      // NDJSON: process every complete line.
      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let request: CliRequest;
        try {
          request = JSON.parse(line) as CliRequest;
        } catch {
          // Ignore malformed messages.
          continue;
        }

        // If the NM connection is down, fail immediately instead of hanging.
        if (!nmAlive) {
          const errResponse: CliResponse = {
            id: request.id,
            success: false,
            error:
              "HAEVN extension is not connected.\n" +
              "Make sure Chrome is open with the HAEVN extension active.",
            code: "NM_DISCONNECTED",
          };
          if (!client.destroyed) client.write(`${JSON.stringify(errResponse)}\n`);
          continue;
        }

        // Register the client as waiting for this request id.
        pending.set(request.id, client);

        // Forward to the Chrome extension via NM stdout.
        writeNativeMessage(request).catch(() => {
          pending.delete(request.id);
          const errResponse: CliResponse = {
            id: request.id,
            success: false,
            error: "Failed to forward request to extension.",
            code: "FORWARD_FAILED",
          };
          if (!client.destroyed) client.write(`${JSON.stringify(errResponse)}\n`);
        });
      }
    });

    // If the CLI client disconnects early, clean up its pending requests.
    const cleanupClient = () => {
      for (const [id, sock] of pending) {
        if (sock === client) pending.delete(id);
      }
    };
    client.on("close", cleanupClient);
    client.on("error", cleanupClient);
  });

  server.listen(SOCKET_PATH);
  server.on("error", (err) => {
    process.stderr.write(`[haevn daemon] Socket error: ${err.message}\n`);
    process.exit(1);
  });

  // ── NM stdin loop ───────────────────────────────────────────────────────────
  // Reads responses (and keepalive pings) arriving from the Chrome extension.

  (async () => {
    while (true) {
      let msg: unknown;
      try {
        msg = await readNativeMessage();
      } catch {
        break; // stdin EOF = Chrome closed the connection.
      }
      if (msg === null) break;

      const m = msg as Record<string, unknown>;

      // Extension keepalive ping – discard.
      if (m.action === "ping") continue;

      // Route response back to the waiting CLI client.
      const id = m.id as string | undefined;
      if (id) {
        const sock = pending.get(id);
        pending.delete(id);
        if (sock && !sock.destroyed) {
          sock.write(`${JSON.stringify(m)}\n`);
        }
      }
    }

    // NM disconnected – fail all in-flight requests gracefully.
    nmAlive = false;
    for (const [id, sock] of pending) {
      if (!sock.destroyed) {
        const errResponse: CliResponse = {
          id,
          success: false,
          error: "Extension disconnected while processing your request.",
          code: "NM_DISCONNECTED",
        };
        sock.write(`${JSON.stringify(errResponse)}\n`);
      }
    }
    pending.clear();
  })();

  // ── Graceful shutdown ───────────────────────────────────────────────────────

  const shutdown = () => {
    server.close();
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Already gone.
    }
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Block until the server closes (keeps the daemon alive).
  await new Promise<void>((resolve) => server.on("close", resolve));
}
