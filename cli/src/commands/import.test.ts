import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import type { ImportResult } from "../types";
import { consola } from "../utils/output";
import importCommand, { summarizeImport } from "./import";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));

const savedResult: ImportResult = {
  format: "haevn_json",
  total: 2,
  processed: 2,
  saved: 2,
  skipped: 0,
  errors: 0,
};

// The command reads its input before it asks the daemon, so it needs a file that exists.
const inputFile = fileURLToPath(new URL("../../package.json", import.meta.url));

async function runImport(): Promise<void> {
  const run = importCommand.run;
  if (!run) throw new Error("the import command has no run function");
  const args = {
    format: "haevn_json",
    file: inputFile,
    _: [],
    "no-overwrite": false,
    "skip-index": false,
  };
  await run({ args } as unknown as Parameters<typeof run>[0]);
}

/** Everything a spy on consola.log was asked to print, joined by newlines. */
function printed(log: { mock: { calls: unknown[][] } }): string {
  return log.mock.calls.map((call) => String(call[0])).join("\n");
}

describe("summarizeImport (HVN-11)", () => {
  it("names the failed index with its reason, and asks for exit 1", () => {
    const summary = summarizeImport(
      { ...savedResult, indexError: "search index is locked" },
      { format: "haevn_json", skipIndex: false },
    );

    expect(summary.exitCode).toBe(1);
    expect(summary.lines.at(-1)).toBe(
      "  skipped=0 · errors=0 · index=failed (search index is locked)",
    );
  });

  it("names each file that was not saved, with its reason, after the counts (HVN-163)", () => {
    const summary = summarizeImport(
      {
        ...savedResult,
        saved: 0,
        errors: 2,
        failed: [
          { name: "a.jsonl", message: "not a session file" },
          { name: "b.jsonl", message: "disk full" },
        ],
      },
      { format: "pi", skipIndex: false },
    );

    const text = summary.lines.join("\n");
    expect(text).toContain("failed       a.jsonl · not a session file");
    expect(text).toContain("failed       b.jsonl · disk full");
    expect(text.indexOf("errors=2")).toBeLessThan(text.indexOf("a.jsonl"));
  });

  it("prints no failed line for an extension that does not say which files failed", () => {
    const summary = summarizeImport(
      { ...savedResult, errors: 1 },
      { format: "pi", skipIndex: false },
    );

    expect(summary.lines.join("\n")).not.toContain("failed ");
  });

  it("says no chats were found, and exits 1, when the files held none", () => {
    const summary = summarizeImport(
      { ...savedResult, total: 0, processed: 0, saved: 0 },
      { format: "openrouter", skipIndex: false },
    );

    expect(summary.exitCode).toBe(1);
    expect(summary.lines.join("\n")).toContain("No chats found in the input");
    expect(summary.lines.join("\n")).not.toContain("Imported");
  });

  it("reports the index as skipped, and exits 0, when indexing was turned off", () => {
    const summary = summarizeImport(savedResult, { format: "haevn_json", skipIndex: true });

    expect(summary.exitCode).toBe(0);
    expect(summary.lines.at(-1)).toContain("index=skipped");
  });
});

describe("haevn import exit status (HVN-11)", () => {
  beforeEach(() => {
    vi.mocked(daemonRequest).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the failed index and exits 1 when the daemon saved the chats but could not index them", async () => {
    vi.mocked(daemonRequest).mockResolvedValue({
      ...savedResult,
      indexError: "search index is locked",
    });
    const log = vi.spyOn(consola, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runImport();

    expect(exit).toHaveBeenCalledWith(1);
    expect(printed(log)).toContain("index=failed (search index is locked)");
  });

  it("does not exit when the index was updated", async () => {
    vi.mocked(daemonRequest).mockResolvedValue(savedResult);
    const log = vi.spyOn(consola, "log").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await runImport();

    expect(exit).not.toHaveBeenCalled();
    expect(printed(log)).toContain("index=updated");
  });
});
