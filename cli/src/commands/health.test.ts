import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { runAsTyped } from "../testing/runAsTyped";
import type { HealthReport, HealthRow } from "../types";
import { consola } from "../utils/output";
import healthCommand, { formatHealthText, parseProviders } from "./health";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));

function row(overrides: Partial<HealthRow> & { provider: string }): HealthRow {
  return {
    signedIn: true,
    listed: 40,
    checked: 2,
    status: "ok",
    findings: [],
    shapes: [],
    ms: 1400,
    ...overrides,
  };
}

function report(rows: HealthRow[]): HealthReport {
  return { extensionVersion: "1.2.1", startedAt: "2026-11-19T14:00:00.000Z", ms: 9200, rows };
}

const mixed = report([
  row({ provider: "claude" }),
  row({
    provider: "gemini",
    status: "fail",
    findings: [
      {
        code: "text.empty",
        level: "fail",
        message: "a text, thinking or prompt part is an empty string",
        count: 3,
        chats: 2,
      },
    ],
  }),
  row({ provider: "grok", status: "not-signed-in", signedIn: false, listed: null, checked: 0 }),
  row({
    provider: "poe",
    status: "warn",
    findings: [
      {
        code: "title.fallback",
        level: "warn",
        message: "the title is a fallback",
        count: 1,
        chats: 1,
      },
    ],
  }),
  row({
    provider: "qwen",
    status: "timeout",
    listed: null,
    checked: 0,
    signedIn: null,
    note: "no answer within 40 s, while listing the chats",
  }),
]);

describe("parseProviders", () => {
  it("reads a comma list in any case, once each, and nothing from a blank flag", () => {
    expect(parseProviders("Claude, chatgpt,claude")).toEqual(["claude", "chatgpt"]);
    expect(parseProviders(undefined)).toBeUndefined();
    expect(parseProviders(" , ")).toBeUndefined();
  });
});

describe("formatHealthText", () => {
  it("prints one row per provider and says what each status means", () => {
    const text = formatHealthText(mixed);
    for (const name of ["claude", "gemini", "grok", "poe", "qwen"]) expect(text).toContain(name);
    expect(text).toContain("not signed in");
    expect(text).toContain("FAIL");
    expect(text).toContain("TIMEOUT");
    expect(text).toContain("extension 1.2.1");
  });

  it("lists the findings and notes under the table, with their counts", () => {
    const text = formatHealthText(mixed);
    expect(text).toContain("text.empty x3 in 2 of 2 chats");
    expect(text).toContain("title.fallback x1");
    expect(text).toContain("note: no answer within 40 s, while listing the chats");
  });

  it("counts what was checked and what was not, so a skipped provider is not read as a pass", () => {
    const text = formatHealthText(mixed);
    expect(text).toContain("3 of 5 providers checked, 2 failed, 1 not checked");
  });

  it("replaces control characters in the extension's sentences", () => {
    const text = formatHealthText(
      report([row({ provider: "claude", status: "fail", note: "bad \u001b[31mred\u0007" })]),
    );
    expect(text).not.toContain("\u001b[31m");
    expect(text).not.toContain("\u0007");
  });
});

describe("haevn health", () => {
  beforeEach(() => {
    vi.mocked(daemonRequest).mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function exits() {
    return vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
  }

  it("asks the daemon for a health report, with a wait long enough for the run", async () => {
    vi.mocked(daemonRequest).mockResolvedValue(report([row({ provider: "claude" })]));
    vi.spyOn(consola, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAsTyped(healthCommand, []);

    expect(daemonRequest).toHaveBeenCalledWith({ action: "health", options: {} }, 280_000);
  });

  it("passes the provider list, the chat count and the time limit on", async () => {
    vi.mocked(daemonRequest).mockResolvedValue(report([row({ provider: "claude" })]));
    vi.spyOn(consola, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAsTyped(healthCommand, ["-p", "Claude,grok", "-n", "3", "--timeout", "60"]);

    expect(daemonRequest).toHaveBeenCalledWith(
      { action: "health", options: { providers: ["claude", "grok"], chats: 3, timeoutMs: 60_000 } },
      280_000,
    );
  });

  it("prints the report as JSON with -f json, and nothing else on stdout", async () => {
    const full = report([row({ provider: "claude" })]);
    vi.mocked(daemonRequest).mockResolvedValue(full);
    const log = vi.spyOn(consola, "log").mockImplementation(() => undefined);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runAsTyped(healthCommand, ["-f", "json"]);

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(full);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("exits 1 when a provider failed or timed out, 0 when none did", async () => {
    vi.spyOn(consola, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = exits();

    vi.mocked(daemonRequest).mockResolvedValue(mixed);
    await expect(runAsTyped(healthCommand, [])).rejects.toThrow("exit 1");

    exit.mockClear();
    vi.mocked(daemonRequest).mockResolvedValue(
      report([
        row({ provider: "claude" }),
        row({ provider: "grok", status: "not-signed-in", signedIn: false }),
        row({ provider: "poe", status: "warn" }),
      ]),
    );
    await runAsTyped(healthCommand, []);
    expect(exit).not.toHaveBeenCalled();
  });

  it.each([
    [["-n", "0"], '--chats must be a whole number, 1 or more (got "0").'],
    [["-n", "6"], '--chats must be a whole number, 1 to 5 (got "6").'],
    [["--chats", "x"], '--chats must be a whole number, 1 or more (got "x").'],
    [["--timeout", "2"], '--timeout must be a whole number, 5 or more (got "2").'],
    [["--timeout", "500"], '--timeout must be a whole number of seconds, 5 to 120 (got "500").'],
  ])("%j is refused before the daemon is asked", async (rawArgs, message) => {
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    exits();

    await expect(runAsTyped(healthCommand, rawArgs)).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(message);
    expect(daemonRequest).not.toHaveBeenCalled();
  });

  it("reports a refusal from the extension (a busy lock, an unknown provider) and exits 1", async () => {
    vi.mocked(daemonRequest).mockRejectedValue(new Error("Another operation is running (import)."));
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    exits();

    await expect(runAsTyped(healthCommand, [])).rejects.toThrow("exit 1");
    expect(error).toHaveBeenCalledWith("Another operation is running (import).");
  });
});
