/**
 * Native messaging host entry point.
 *
 * Chrome calls this (via the --native-host flag) when the extension invokes
 * `chrome.runtime.connectNative("com.haevn.cli")`.
 *
 * Instead of handling one message and exiting (the old one-shot model), we
 * launch the daemon, which stays alive for the lifetime of the NM connection
 * and bridges CLI clients (Unix socket) to the Chrome extension (NM stdio).
 */

import { runDaemon } from "./daemon";

export async function runNativeHost(): Promise<void> {
  await runDaemon();
}
