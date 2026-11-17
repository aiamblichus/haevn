/**
 * What the extension bridge does when the daemon closes its WebSocket.
 *
 * The daemon (`cli/src/daemon/server.ts`) closes with a private code when it has something to
 * say: 4001 for a bad API key, 4002 when a newer extension connection replaced this one.
 *
 * - 4002 is final. Reconnecting would replace the other extension in turn, and two extensions
 *   sharing a key would trade the connection for ever.
 * - 4001 is not. The key is checked on every connection, and the usual fix is on the daemon's
 *   side (it is restarted with the right key), which the extension cannot see; so it keeps
 *   trying, slowly.
 * - Any other close (no daemon, a network blip, a sleeping service worker) reconnects at once.
 */

/** The daemon rejected the API key (it also sends an `authError` frame first). */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** A newer extension connection with the same key replaced this one. */
export const WS_CLOSE_REPLACED = 4002;

export const WS_REASON_UNAUTHORIZED =
  "the daemon rejected the API key (start the daemon with the key shown in Settings)";
export const WS_REASON_REPLACED =
  "another extension connected to the daemon with the same API key and replaced this connection";

/** The first retry after a rejected key comes after this long, and each one doubles it. */
export const REJECTED_RETRY_BASE_MS = 30_000;
/** A rejected key is retried at least this often. */
export const REJECTED_RETRY_MAX_MS = 300_000;

/**
 * Why the bridge must stop for good after this close code, or `null` when it should reconnect
 * (a rejected key included: see `isKeyRejected`).
 */
export function terminalCloseReason(code: number): string | null {
  return code === WS_CLOSE_REPLACED ? WS_REASON_REPLACED : null;
}

/** The daemon refused the key: retry slowly, not at the ordinary pace and not never. */
export function isKeyRejected(code: number): boolean {
  return code === WS_CLOSE_UNAUTHORIZED;
}

/** How long to wait before the next try after the key was rejected `attempts` times before. */
export function rejectedRetryDelayMs(attempts: number): number {
  return Math.min(REJECTED_RETRY_BASE_MS * 2 ** attempts, REJECTED_RETRY_MAX_MS);
}
