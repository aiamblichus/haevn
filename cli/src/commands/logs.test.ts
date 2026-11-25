import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { loadConfig } from "../daemon/config.js";
import { type DaemonServer, startDaemon } from "../daemon/server.js";
import { FakeExtension, type FakeExtensionOptions } from "../testing/fakeExtension.js";
import { runAsTyped } from "../testing/runAsTyped";
import type { LogEntry } from "../types";
import { consola } from "../utils/output";
import logsCommand, { formatLogText, parseLogsOptions } from "./logs";

// The command, a real daemon and a fake extension over a real WebSocket: the request goes through
// the same path a user's `haevn logs` takes, and the fake answers with the entries it was given.

vi.mock("../daemon/config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: vi.fn(() => ({})),
}));

const KEY = "test-key";
const T0 = Date.parse("2026-11-25T10:00:00.000Z");

const ENTRIES: LogEntry[] = [
  {
    id: "1",
    timestamp: T0,
    level: "INFO",
    message: "Sync started for claude",
    context: "background",
    data: { chatId: "chat-1", provider: "claude" },
  },
  {
    id: "2",
    timestamp: T0 + 1500,
    level: "WARN",
    message: "Chat list repeated a page token",
    context: "background",
  },
  {
    id: "3",
    timestamp: T0 + 2000,
    level: "ERROR",
    message: "Sync failed",
    context: "content-tab-7",
    tabId: 7,
    stack: "Error: boom\n    at sync (sync.js:1:1)",
  },
];

/** An escape sequence starts with ESC; colour codes are taken out before the output is compared. */
const COLOUR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

let port: number;
let daemon: DaemonServer;
let extensions: FakeExtension[] = [];
let log: MockInstance;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port: bound } = server.address() as net.AddressInfo;
      server.close(() => resolve(bound));
    });
  });
}

/** An extension connected to the daemon: the command's request reaches it, and it answers. */
async function connect(options: FakeExtensionOptions = {}): Promise<FakeExtension> {
  const extension = new FakeExtension(port, [], { key: KEY, ...options });
  extensions.push(extension);
  extension.start();
  await vi.waitFor(async () => {
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      extensionConnected: boolean;
    };
    expect(health.extensionConnected).toBe(true);
  });
  return extension;
}

/** The text the command printed, with its colours taken out. */
function printed(): string {
  return log.mock.calls.map((call) => String(call[0]).replace(COLOUR, "")).join("\n");
}

beforeEach(async () => {
  port = await freePort();
  vi.mocked(loadConfig).mockReturnValue({ port, apiKey: KEY });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  log = vi.spyOn(consola, "log").mockImplementation(() => undefined);
  daemon = await startDaemon({ port, apiKey: KEY });
  extensions = [];
});

afterEach(async () => {
  for (const extension of extensions) extension.stop();
  await daemon.stop();
  vi.restoreAllMocks();
});

describe("haevn logs sends the flags as the request's options (HVN-156)", () => {
  it("asks for the newest 200 entries when no flag is given", async () => {
    const extension = await connect({ logs: ENTRIES });

    await runAsTyped(logsCommand, []);

    expect(extension.logRequests).toEqual([{ limit: 200 }]);
  });

  it("maps -n, --level, --context and --match to the filter, and the level to its name", async () => {
    const extension = await connect({ logs: ENTRIES });

    await runAsTyped(logsCommand, [
      "-n",
      "5",
      "--level",
      "warn",
      "--context",
      "background",
      "--match",
      "sync",
    ]);

    expect(extension.logRequests).toEqual([
      { limit: 5, level: "WARN", context: "background", match: "sync" },
    ]);
  });
});

describe("haevn logs prints what the extension answers (HVN-156)", () => {
  it("prints one line per entry, oldest first: timestamp, level, context, message", async () => {
    await connect({ logs: ENTRIES });

    await runAsTyped(logsCommand, []);

    expect(printed().split("\n")).toEqual([
      "2026-11-25T10:00:00.000Z INFO  background Sync started for claude",
      "2026-11-25T10:00:01.500Z WARN  background Chat list repeated a page token",
      "2026-11-25T10:00:02.000Z ERROR content-tab-7 Sync failed",
    ]);
  });

  it("prints the entries as the extension holds them with --format json", async () => {
    await connect({ logs: ENTRIES });

    await runAsTyped(logsCommand, ["--format", "json"]);

    expect(JSON.parse(printed())).toEqual(ENTRIES);
  });
});

describe("the text output of haevn logs (HVN-156)", () => {
  it("says so when no entry matches", () => {
    expect(formatLogText([])).toBe("No log entries match.");
  });

  it("keeps a message with a line break on its line, and a control character out of the terminal", () => {
    const text = formatLogText([
      {
        id: "x",
        timestamp: T0,
        level: "INFO",
        message: "first\nsecond\u001b]0;pwned\u0007",
        context: "popup",
      },
    ]).replace(COLOUR, "");

    expect(text.split("\n")).toHaveLength(1);
    expect(text).toContain("first\\nsecond");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });
});

describe("haevn logs refuses what it cannot ask for, and exits 1 (HVN-156)", () => {
  beforeEach(() => {
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
  });

  it.each([
    [["-n", "1001"], '--limit must be a whole number, 1 to 1000 (got "1001").'],
    [["--limit", "0"], '--limit must be a whole number, 1 to 1000 (got "0").'],
    [["-n", "abc"], '--limit must be a whole number, 1 to 1000 (got "abc").'],
    [["--level", "loud"], '--level must be debug, info, warn or error (got "loud").'],
  ])("%j exits 1 with the message, before it asks the extension", async (rawArgs, message) => {
    const extension = await connect({ logs: ENTRIES });
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);

    await expect(runAsTyped(logsCommand, rawArgs)).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(message);
    expect(extension.logRequests).toEqual([]);
  });

  it("exits 1 with the extension's sentence when the extension answers an error", async () => {
    await connect({
      logs: ENTRIES,
      fault: (frame) =>
        frame.action === "logs"
          ? { error: "BAD_REQUEST", message: "limit must be a whole number, 1 to 1000" }
          : undefined,
    });
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);

    await expect(runAsTyped(logsCommand, ["-n", "5"])).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith("limit must be a whole number, 1 to 1000");
    expect(log).not.toHaveBeenCalled();
  });
});

describe("parseLogsOptions (HVN-156)", () => {
  it("leaves out what was not given, and reads the level in any case", () => {
    expect(parseLogsOptions({})).toEqual({ limit: 200 });
    expect(parseLogsOptions({ level: "Error", match: "x" })).toEqual({
      limit: 200,
      level: "ERROR",
      match: "x",
    });
  });

  it("accepts the limit's edges, 1 and 1000", () => {
    expect(parseLogsOptions({ limit: "1" })).toEqual({ limit: 1 });
    expect(parseLogsOptions({ limit: "1000" })).toEqual({ limit: 1000 });
  });
});
