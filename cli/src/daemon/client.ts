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

import type { CliRequestBody, CliResponse } from "../types.js";
import { DEFAULT_DAEMON_PORT, loadConfig } from "./config.js";

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
): Promise<T> {
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

  return (payload as Extract<typeof payload, { success: true }>).data;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
