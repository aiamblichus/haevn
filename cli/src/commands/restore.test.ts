import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RestorePlan } from "../backup/plan.js";
import { type RestoreResult, runRestore } from "../backup/restoreEngine.js";
import { deferred, failed } from "../utils/exit.js";
import restoreCommand, { askLine, restoreExitCode, type Terminal } from "./restore";

vi.mock("../backup/restoreEngine.js", () => ({ runRestore: vi.fn() }));
vi.mock("../daemon/config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: vi.fn(() => ({ port: 5599, apiKey: "the-key" })),
}));

const plan: RestorePlan = {
  dir: "/b/archive",
  createdAt: "2026-11-23T03:00:00.000Z",
  haevnVersion: "1.9.0",
  backupChats: 12,
  backupBytes: 5_000_000,
  chats: 12,
  mediaFiles: 3,
  bytes: 5_000_000,
  replaced: 8,
  changed: 2,
  added: 4,
};

const done: RestoreResult = {
  dryRun: false,
  plan,
  replaced: 8,
  added: 4,
  mediaFiles: 3,
  bytes: 5_000_000,
  ms: 2_500,
};

let stderr: string[];
let stdout: string[];

function terminal(interactive: boolean, answer = "y"): Terminal & { questions: string[] } {
  const questions: string[] = [];
  return {
    interactive,
    questions,
    async ask(question) {
      questions.push(question);
      return answer;
    },
  };
}

function command(extra: Partial<Parameters<typeof restoreExitCode>[0]> = {}) {
  return {
    dir: "/b/archive",
    rawArgs: ["/b/archive"],
    dryRun: false,
    yes: false,
    waitText: undefined,
    ...extra,
  };
}

beforeEach(() => {
  vi.mocked(runRestore).mockReset();
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

describe("haevn restore, the exit code", () => {
  it("is 0 when the restore is done, and says what it did", async () => {
    vi.mocked(runRestore).mockResolvedValue(done);

    expect(await restoreExitCode(command({ yes: true }), terminal(false))).toBe(0);

    expect(stdout.join("")).toContain(
      "Restored 12 chats (8 replaced, 4 added) and 3 media files (4.8 MB) in 2.5 s.",
    );
    expect(stderr.join("")).toBe("");
  });

  it("is 75 when the run is deferred, and the line says it was 'not now'", async () => {
    vi.mocked(runRestore).mockRejectedValue(deferred("the extension is busy: a bulk sync"));

    expect(await restoreExitCode(command({ yes: true }), terminal(false))).toBe(75);

    expect(stderr.join("")).toBe(
      "haevn restore: not now (exit 75): the extension is busy: a bulk sync\n",
    );
  });

  it("is 1 when the run failed, and when something throws that is not an exit", async () => {
    vi.mocked(runRestore).mockRejectedValueOnce(failed("the backup is damaged"));
    expect(await restoreExitCode(command({ yes: true }), terminal(false))).toBe(1);
    expect(stderr.join("")).toBe("haevn restore: failed (exit 1): the backup is damaged\n");

    vi.mocked(runRestore).mockRejectedValueOnce(new Error("boom"));
    expect(await restoreExitCode(command({ yes: true }), terminal(false))).toBe(1);
  });

  it("is 1 for a --wait that is not a whole number, before it reaches for anything", async () => {
    expect(await restoreExitCode(command({ yes: true, waitText: "soon" }), terminal(false))).toBe(
      1,
    );

    expect(stderr.join("")).toContain("--wait must be a whole number");
    expect(runRestore).not.toHaveBeenCalled();
  });

  it("is 1 for a --chat with no value", async () => {
    const rawArgs = ["/b/archive", "--chat"];

    expect(await restoreExitCode(command({ yes: true, rawArgs }), terminal(false))).toBe(1);

    expect(stderr.join("")).toContain("--chat needs a value");
    expect(runRestore).not.toHaveBeenCalled();
  });
});

describe("haevn restore, asking first", () => {
  it("with no terminal and no --yes it ends 1, names --dry-run and --yes, and reaches for nothing", async () => {
    expect(await restoreExitCode(command(), terminal(false))).toBe(1);

    const line = stderr.join("");
    expect(line).toContain("no terminal to ask on");
    expect(line).toContain("--dry-run");
    expect(line).toContain("--yes");
    expect(runRestore).not.toHaveBeenCalled();
  });

  it("with no terminal and --dry-run it runs: a dry run needs no consent", async () => {
    vi.mocked(runRestore).mockResolvedValue({ ...done, dryRun: true, replaced: 0, added: 0 });

    expect(await restoreExitCode(command({ dryRun: true }), terminal(false))).toBe(0);

    expect(runRestore).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it("prints the same block for a dry run, without the question, and says nothing was written", async () => {
    vi.mocked(runRestore).mockResolvedValue({ ...done, dryRun: true, replaced: 0, added: 0 });
    const tty = terminal(true);

    await restoreExitCode(command({ dryRun: true }), tty);

    const out = stdout.join("");
    expect(out).toContain("Restore from /b/archive");
    expect(out).toContain("8  chats are in your archive now");
    expect(out).toContain("Dry run: nothing was written.");
    expect(tty.questions).toEqual([]);
  });

  it("asks on a terminal with the block above the question, and goes on only for y or yes", async () => {
    const confirmWith = async (answer: string): Promise<boolean> => {
      stdout = [];
      let confirmed = false;
      vi.mocked(runRestore).mockImplementationOnce(async (options) => {
        confirmed = (await options.confirm?.(plan)) ?? false;
        return done;
      });
      const tty = terminal(true, answer);
      await restoreExitCode(command(), tty);
      expect(tty.questions).toEqual([
        "Restore 12 chats into the haevn connected to this terminal? [y/N] ",
      ]);
      expect(stdout.join("")).toContain(
        "Chats that are not in the backup are not touched. Nothing is deleted.",
      );
      return confirmed;
    };

    expect(await confirmWith("y")).toBe(true);
    expect(await confirmWith(" YES ")).toBe(true);
    expect(await confirmWith("")).toBe(false); // the default is no
    expect(await confirmWith("n")).toBe(false);
    expect(await confirmWith("yep")).toBe(false);
  });

  it("with --yes it shows the block and does not ask", async () => {
    let confirmed = false;
    vi.mocked(runRestore).mockImplementation(async (options) => {
      confirmed = (await options.confirm?.(plan)) ?? false;
      return done;
    });
    const tty = terminal(true, "n");

    await restoreExitCode(command({ yes: true }), tty);

    expect(confirmed).toBe(true);
    expect(tty.questions).toEqual([]);
    expect(stdout.join("")).toContain("Restore from /b/archive");
  });

  it("hands the engine the chats, the wait and the dry-run flag as typed", async () => {
    vi.mocked(runRestore).mockResolvedValue(done);
    const rawArgs = ["/b/archive", "--chat", "a", "--chat=b", "--wait", "5"];

    await restoreExitCode(command({ yes: true, rawArgs, waitText: "5" }), terminal(false));

    expect(runRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        dir: "/b/archive",
        chatIds: ["a", "b"],
        waitMs: 5_000,
        dryRun: false,
        endpoint: { port: 5599, apiKey: "the-key" },
      }),
    );
  });
});

describe("haevn restore, as a command", () => {
  it("is named restore, takes the backup directory, and has the three flags the README names", () => {
    const meta = restoreCommand.meta as { name: string };
    const args = restoreCommand.args as Record<string, { type: string }>;

    expect(meta.name).toBe("restore");
    expect(args.dir.type).toBe("positional");
    expect(Object.keys(args).sort()).toEqual(["chat", "dir", "dry-run", "wait", "yes"]);
  });
});

describe("haevn restore, reading the answer", () => {
  it("is what was typed, though closing the prompt ends the question too", async () => {
    const input = new PassThrough();
    const output = new PassThrough();

    const answer = askLine("Restore? [y/N] ", input, output);
    input.write("y\n");

    expect(await answer).toBe("y");
    expect(output.read()?.toString()).toContain("Restore? [y/N] ");
  });

  it("is empty, so no, when the input ends before an answer", async () => {
    const input = new PassThrough();
    const answer = askLine("Restore? [y/N] ", input, new PassThrough());

    input.end();

    expect(await answer).toBe("");
  });
});
