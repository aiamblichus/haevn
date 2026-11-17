/**
 * What the extension bridge does when the daemon closes its WebSocket.
 *
 * The daemon (`cli/src/daemon/server.ts`) closes with a private code when reconnecting would
 * be wrong: 4001 for a bad API key, 4002 when a newer extension connection replaced this one.
 * Any other close (no daemon, a network blip, a sleeping service worker) is worth retrying.
 */

/** The daemon rejected the API key (it also sends an `authError` frame first). */
export const WS_CLOSE_UNAUTHORIZED = 4001;

/** A newer extension connection with the same key replaced this one. */
export const WS_CLOSE_REPLACED = 4002;

export const WS_REASON_UNAUTHORIZED = "the daemon rejected the API key";
export const WS_REASON_REPLACED =
  "another extension connected to the daemon with the same API key and replaced this connection";

/**
 * Why the bridge must stop reconnecting after this close code, or `null` when it should
 * reconnect as usual.
 */
export function terminalCloseReason(code: number): string | null {
  if (code === WS_CLOSE_UNAUTHORIZED) return WS_REASON_UNAUTHORIZED;
  if (code === WS_CLOSE_REPLACED) return WS_REASON_REPLACED;
  return null;
}
