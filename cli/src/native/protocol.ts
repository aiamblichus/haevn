/**
 * Native Messaging protocol helpers + shared constants.
 *
 * Chrome Native Messaging uses a simple length-prefixed JSON protocol:
 *   [4-byte LE uint32: payload length][UTF-8 JSON payload]
 *
 * The daemon (native host) communicates with the Chrome extension over NM stdio,
 * and with CLI commands over a Unix socket (or Windows named pipe).
 * Messages on the socket use newline-delimited JSON (NDJSON): one JSON object per line.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { CliRequest, CliResponse } from "../types";

// ─── Socket path ──────────────────────────────────────────────────────────────

/**
 * Well-known path for the daemon's IPC socket.
 * - macOS / Linux: ~/.haevn/daemon.sock  (Unix domain socket)
 * - Windows:        \\.\pipe\haevn-daemon (named pipe; same net API)
 */
export const SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\haevn-daemon"
    : path.join(os.homedir(), ".haevn", "daemon.sock");

// ─── Request ID generation ────────────────────────────────────────────────────

let _counter = 0;

/** Generate a lightweight unique request ID (process-scoped monotonic counter). */
export function generateRequestId(): string {
  return `${process.pid}-${Date.now()}-${++_counter}`;
}

// ─── Native Messaging manifest ────────────────────────────────────────────────

/**
 * Native messaging manifest structure.
 * Installed to:
 * - macOS: ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.haevn.cli.json
 * - Linux: ~/.config/google-chrome/NativeMessagingHosts/com.haevn.cli.json
 * - Windows: Registry
 */
export interface NativeMessagingManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

/**
 * Read a native message from stdin.
 * Returns null if no input available.
 */
export async function readNativeMessage<T = CliRequest>(): Promise<T | null> {
  // Read 4-byte length prefix
  const lengthBuffer = new Uint8Array(4);

  // In Node.js, read from stdin
  const bytesRead = await readBytesFromStdin(lengthBuffer, 0, 4);

  if (bytesRead < 4) {
    return null;
  }

  // Convert to length (little-endian)
  const length =
    lengthBuffer[0] | (lengthBuffer[1] << 8) | (lengthBuffer[2] << 16) | (lengthBuffer[3] << 24);

  // Sanity check
  if (length <= 0 || length > 16 * 1024 * 1024) {
    throw new Error(`Invalid message length: ${length}`);
  }

  // Read payload
  const payloadBuffer = new Uint8Array(length);
  await readBytesFromStdin(payloadBuffer, 0, length);

  // Decode JSON
  const payload = new TextDecoder().decode(payloadBuffer);
  return JSON.parse(payload) as T;
}

/**
 * Write a native message to stdout.
 */
export async function writeNativeMessage<T = CliResponse>(message: T): Promise<void> {
  const payload = JSON.stringify(message);
  const payloadBuffer = new TextEncoder().encode(payload);

  // Write length prefix (little-endian)
  const length = payloadBuffer.length;
  const lengthBuffer = new Uint8Array([
    length & 0xff,
    (length >> 8) & 0xff,
    (length >> 16) & 0xff,
    (length >> 24) & 0xff,
  ]);

  await writeBytesToStdout(lengthBuffer);
  await writeBytesToStdout(payloadBuffer);
}

/**
 * Helper: Read exact number of bytes from stdin.
 */
async function readBytesFromStdin(
  buffer: Uint8Array,
  offset: number,
  length: number,
): Promise<number> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let read = 0;

    const onReadable = () => {
      while (read < length) {
        const chunk = stdin.read(length - read);
        if (!chunk) break;
        buffer.set(chunk, offset + read);
        read += chunk.length;
      }
      if (read >= length) {
        cleanup();
        resolve(read);
      }
    };

    const onEnd = () => {
      cleanup();
      resolve(read);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const cleanup = () => {
      stdin.off("readable", onReadable);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
    };

    stdin.on("readable", onReadable);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

/**
 * Helper: Write bytes to stdout.
 */
async function writeBytesToStdout(buffer: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(buffer, (err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Generate native messaging manifest content.
 */
export function generateManifest(cliPath: string, extensionId: string): NativeMessagingManifest {
  return {
    name: "com.haevn.cli",
    description: "HAEVN CLI - Access your AI conversation archive",
    path: cliPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
}
