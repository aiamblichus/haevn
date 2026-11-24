import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runBackup } from "../backup/engine.js";
import { loadConfig } from "../daemon/config.js";
import { runAsTyped } from "../testing/runAsTyped";
import { deferred, failed } from "../utils/exit.js";
import backupCommand, { backupExitCode } from "./backup";

vi.mock("../backup/engine.js", () => ({ runBackup: vi.fn() }));
vi.mock("../daemon/config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: vi.fn(() => ({ port: 5599, apiKey: "the-key" })),
}));

const done = {
  dir: "/b/archive",
  chats: 12,
  mediaFiles: 3,
  bytes: 5_000_000,
  vanished: [],
  ms: 2_500,
};

let stderr: string[];
let stdout: string[];

beforeEach(() => {
  vi.mocked(runBackup).mockReset();
  stderr = [];
  stdout = [];
  vi.spyOn(process.stderr, "write").mockImplementation((text) => {
    stderr.push(String(text));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((text) => {
    stdout.push(String(text));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("haevn backup, the exit code", () => {
  it("is 0 when the backup is done, and says what it wrote", async () => {
    vi.mocked(runBackup).mockResolvedValue(done);

    expect(await backupExitCode("/b/archive", undefined)).toBe(0);

    expect(stdout.join("")).toContain(
      "Backed up 12 chats and 3 media files (4.8 MB) to /b/archive in 2.5 s.",
    );
    expect(stderr.join("")).toBe("");
  });

  it("is 75 when the run is deferred, and the line says it was 'not now'", async () => {
    vi.mocked(runBackup).mockRejectedValue(deferred("no extension connected within 60 s"));

    expect(await backupExitCode("/b/archive", undefined)).toBe(75);

    expect(stderr.join("")).toBe(
      "haevn backup: not now (exit 75): no extension connected within 60 s\n",
    );
  });

  it("is 1 when the run failed, and the line says it failed", async () => {
    vi.mocked(runBackup).mockRejectedValue(failed("chat c1: the row would not parse"));

    expect(await backupExitCode("/b/archive", undefined)).toBe(1);

    expect(stderr.join("")).toBe(
      "haevn backup: failed (exit 1): chat c1: the row would not parse\n",
    );
  });

  it("is 1 for a crash nobody planned for, never 75", async () => {
    vi.mocked(runBackup).mockRejectedValue(new TypeError("boom"));

    expect(await backupExitCode("/b/archive", undefined)).toBe(1);
    expect(stderr.join("")).toContain("failed (exit 1): boom");
  });

  it("is 1 when there is no API key to start a daemon with, before it does anything", async () => {
    vi.mocked(loadConfig).mockReturnValueOnce({ port: 5599 });

    expect(await backupExitCode("/b/archive", undefined)).toBe(1);

    expect(stderr.join("")).toContain("no API key");
    expect(runBackup).not.toHaveBeenCalled();
  });

  it("is 1 for a --wait that is not a number, before it does anything", async () => {
    expect(await backupExitCode("/b/archive", "soon")).toBe(1);
    expect(stderr.join("")).toContain("--wait must be a whole number");
    expect(runBackup).not.toHaveBeenCalled();
  });
});

describe("haevn backup, the command", () => {
  it("hands the engine the directory, the daemon from the config file and --wait in milliseconds", async () => {
    vi.mocked(runBackup).mockResolvedValue(done);

    await runAsTyped(backupCommand, ["/b/archive", "--wait", "90"]);

    expect(runBackup).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/b/archive",
        endpoint: { port: 5599, apiKey: "the-key" },
        waitMs: 90_000,
      }),
    );
  });

  it("waits 60 s when --wait is not given", async () => {
    vi.mocked(runBackup).mockResolvedValue(done);
    await runAsTyped(backupCommand, ["/b/archive"]);
    expect(vi.mocked(runBackup).mock.calls[0][0].waitMs).toBe(60_000);
  });

  it("exits the process with the code of a run that did not finish", async () => {
    vi.mocked(runBackup).mockRejectedValue(deferred("the extension is busy"));
    const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(runAsTyped(backupCommand, ["/b/archive"])).rejects.toThrow("exit 75");
    expect(exit).toHaveBeenCalledWith(75);
  });

  it("does not exit the process when the backup is done", async () => {
    vi.mocked(runBackup).mockResolvedValue(done);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    await runAsTyped(backupCommand, ["/b/archive"]);
    expect(exit).not.toHaveBeenCalled();
  });
});
