/**
 * Daemon client – connects to the running HAEVN daemon socket and sends a
 * single request, returning the typed response data.
 *
 * Retries automatically if the socket is temporarily unavailable (the extension
 * SW may be waking up and spawning a fresh daemon via the keepalive alarm).
 */

import * as net from "node:net";
import type { CliRequest, CliRequestBody, CliResponse } from "../types";
import { generateRequestId, SOCKET_PATH } from "./protocol";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * How long to pause between connection retries.
 * The NM keepalive alarm fires every 30 s; a few seconds is enough time for
 * a freshly spawned daemon to create its socket.
 */
const RETRY_DELAY_MS = 3_000;
const MAX_RETRIES = 3;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a request to the HAEVN daemon and return the typed response data.
 * Automatically retries up to MAX_RETRIES times on connection failures so that
 * a brief SW dormancy window doesn't immediately fail the user.
 *
 * @param request  Action + payload (without `id` – added internally).
 * @param timeout  Max ms to wait per attempt (default 30 s).
 * @returns        The `data` field from a successful response.
 * @throws         A user-readable Error on final failure.
 */
export async function daemonRequest<T>(
  request: CliRequestBody,
  timeout = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      process.stderr.write(`  Waiting for daemon… (attempt ${attempt}/${MAX_RETRIES})\n`);
      await sleep(RETRY_DELAY_MS);
    }

    try {
      return await attemptRequest<T>(request, timeout);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Only retry on connection-level errors; propagate protocol/app errors.
      const isConnectionError =
        lastError.message.includes("not running") ||
        lastError.message.includes("ENOENT") ||
        lastError.message.includes("ECONNREFUSED") ||
        lastError.message.includes("closed before");

      if (!isConnectionError) throw lastError;
    }
  }

  throw new Error(
    `${lastError?.message ?? "Daemon not available."}\n\n` +
      "Tip: open the HAEVN Options page once to wake the extension,\n" +
      "then retry. The daemon will start automatically.",
  );
}

// ─── Internals ────────────────────────────────────────────────────────────────

async function attemptRequest<T>(request: CliRequestBody, timeout: number): Promise<T> {
  const id = generateRequestId();
  const fullRequest = { ...request, id } as CliRequest;

  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let buf = "";
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };

    const succeed = (data: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(data);
    };

    const timer = setTimeout(
      () => fail(new Error("Request timed out. The extension may be busy.")),
      timeout,
    );

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(fullRequest)}\n`);
    });

    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");

      for (;;) {
        const nl = buf.indexOf("\n");
        if (nl === -1) break;
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;

        let response: CliResponse<T>;
        try {
          response = JSON.parse(line) as CliResponse<T>;
        } catch {
          continue;
        }

        if (response.id !== id) continue;

        if (response.success) {
          succeed(response.data);
        } else {
          fail(new Error(response.error));
        }
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        fail(
          new Error(
            "HAEVN daemon is not running.\n" +
              "Open Chrome and make sure the HAEVN extension is active, then try again.\n" +
              `(Expected socket at: ${SOCKET_PATH})`,
          ),
        );
      } else {
        fail(err);
      }
    });

    socket.on("close", () => {
      fail(new Error("Connection closed before a response was received."));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
