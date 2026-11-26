import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import type { FragmentPlanEntry, ImportResult } from "../types";
import { consola } from "../utils/output";
import {
  assignId,
  assignIds,
  collectFragmentFiles,
  summarizeFragmentImport,
} from "./fragmentImport";
import importCommand from "./import";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));

// HVN-163: the CLI's side of `haevn import --format fragment`. Every file here is made up.

const ID = "7b0e6c1e-2f4a-4c58-9d0b-3a1f5e8c9a12";
let dir: string;

function write(name: string, content: string | Buffer): string {
  const target = path.join(dir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-fragments-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("reading the input", () => {
  it("reads a directory flat: its .md files, in name order, and counts the rest", async () => {
    write("b.md", "b");
    write("a.md", "a");
    write("notes.txt", "t");
    write("data.json", "{}");
    write(".hidden.md", "h");
    write("deeper/c.md", "c");

    const input = await collectFragmentFiles([dir]);

    expect(input.files.map((f) => path.basename(f.name))).toEqual(["a.md", "b.md"]);
    expect(input.notMarkdown).toBe(2);
    expect(input.refused).toEqual([]);
  });

  it("refuses a file named outright that is not .md, with the way out, and reads the others", async () => {
    const text = write("session.txt", "words");
    const md = write("ok.md", "words");

    const input = await collectFragmentFiles([text, md]);

    expect(input.files.map((f) => f.name)).toEqual([md]);
    expect(input.refused).toEqual([
      expect.objectContaining({ name: text, message: expect.stringContaining("rename it to .md") }),
    ]);
  });

  it("reads a file given twice, or in a directory and by name, once", async () => {
    const md = write("a.md", "a");
    const input = await collectFragmentFiles([md, dir, md]);
    expect(input.files).toHaveLength(1);
  });

  it("refuses bytes that are not UTF-8 and keeps a byte-order mark", async () => {
    write("bad.md", Buffer.from([0x68, 0xff, 0xfe, 0x69]));
    write("bom.md", "﻿---\nid: x\n---\nhi");

    const input = await collectFragmentFiles([dir]);

    expect(input.refused).toEqual([
      expect.objectContaining({ state: "unreadable", message: "not valid UTF-8" }),
    ]);
    expect(input.files.find((f) => f.name.endsWith("bom.md"))?.content.startsWith("﻿")).toBe(true);
  });
});

describe("--assign-ids writes the one line and no other change", () => {
  const body = "A body\n---\nwith a rule\n";

  it("puts the id first in a block that is there, and leaves every other byte", () => {
    const file = `---\n# a guess\ntitle: Kept\n---\n${body}`;
    const out = assignId(file, ID);
    expect(out).toBe(`---\nid: ${ID}\n# a guess\ntitle: Kept\n---\n${body}`);
    expect(out.replace(`id: ${ID}\n`, "")).toBe(file);
  });

  it("puts a block in front of a file with none, and keeps the file after it as it was", () => {
    const out = assignId(body, ID);
    expect(out).toBe(`---\nid: ${ID}\n---\n${body}`);
    expect(out.endsWith(body)).toBe(true);
  });

  it("treats a first --- that is never closed as no frontmatter", () => {
    const file = "---\nthis rule opens nothing\n";
    expect(assignId(file, ID)).toBe(`---\nid: ${ID}\n---\n${file}`);
  });

  it("ends the line as the file does", () => {
    expect(assignId("---\r\ntitle: x\r\n---\r\nbody\r\n", ID)).toBe(
      `---\r\nid: ${ID}\r\ntitle: x\r\n---\r\nbody\r\n`,
    );
    expect(assignId("line one\r\nline two\r\n", ID)).toBe(
      `---\r\nid: ${ID}\r\n---\r\nline one\r\nline two\r\n`,
    );
  });

  it("keeps a byte-order mark where it was", () => {
    expect(assignId("﻿---\ntitle: x\n---\nbody", ID)).toBe(`﻿---\nid: ${ID}\ntitle: x\n---\nbody`);
  });

  it("writes the files the plan calls no-id, atomically, and none other", async () => {
    const bare = write("bare.md", body);
    const titled = write("titled.md", "---\ntitle: T\n---\nwords\n");
    const named = write("named.md", `---\nid: ${ID}\n---\nwords\n`);
    const input = await collectFragmentFiles([dir]);
    const plan: FragmentPlanEntry[] = [
      { name: bare, state: "no-id", warnings: [] },
      { name: titled, state: "no-id", warnings: [] },
      { name: named, state: "unchanged", warnings: [] },
    ];

    const given = await assignIds(plan, input.files, input.paths, false);

    expect(given.map((g) => path.basename(g.name))).toEqual(["bare.md", "titled.md"]);
    expect(fs.readFileSync(bare, "utf8")).toBe(`---\nid: ${given[0].id}\n---\n${body}`);
    expect(fs.readFileSync(titled, "utf8")).toBe(`---\nid: ${given[1].id}\ntitle: T\n---\nwords\n`);
    expect(fs.readFileSync(named, "utf8")).toBe(`---\nid: ${ID}\n---\nwords\n`);
    expect(given[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // the payload that is sent next carries the id
    expect(input.files.find((f) => f.name === bare)?.content).toContain(`id: ${given[0].id}`);
    // no temporary file is left behind
    expect(fs.readdirSync(dir).sort()).toEqual(["bare.md", "named.md", "titled.md"]);
  });

  it("changes no file's bytes with --dry-run, and says which it would change", async () => {
    const bare = write("bare.md", body);
    const input = await collectFragmentFiles([dir]);

    const given = await assignIds(
      [{ name: bare, state: "no-id", warnings: [] }],
      input.files,
      input.paths,
      true,
    );

    expect(given).toHaveLength(1);
    expect(fs.readFileSync(bare, "utf8")).toBe(body);
    expect(input.files[0].content).toBe(body);
  });
});

function entry(partial: Partial<FragmentPlanEntry> & { name: string }): FragmentPlanEntry {
  return { state: "new", warnings: [], title: "T", turns: 1, date: "2024", ...partial };
}

function resultOf(plan: FragmentPlanEntry[], extra: Partial<ImportResult> = {}): ImportResult {
  return {
    format: "fragment",
    total: plan.length,
    processed: plan.filter((e) => e.state === "new" || e.state === "changed").length,
    saved: plan.filter((e) => e.state === "new" || e.state === "changed").length,
    skipped: 0,
    errors: 0,
    plan,
    ...extra,
  };
}

const none = { refused: [], notMarkdown: 0 };

describe("what the plan says", () => {
  it("counts files by state on the last line, and exits 0 when none is refused", () => {
    const plan = [
      entry({ name: "a.md" }),
      entry({ name: "b.md" }),
      entry({ name: "c.md", state: "changed" }),
    ];

    const summary = summarizeFragmentImport(resultOf(plan), none, {
      dryRun: true,
      skipIndex: false,
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.lines).toContain("3 files: 2 new · 1 changed · 0 refused · 0 warnings");
    // a dry run lists every file
    expect(summary.lines.filter((l) => l.includes(".md"))).toHaveLength(3);
    expect(summary.lines[0]).toContain("Dry run");
  });

  it("reports the second import of 97 files as 97 unchanged, and lists none of them", () => {
    const plan = Array.from({ length: 97 }, (_, i) =>
      entry({ name: `f${i}.md`, state: "unchanged" }),
    );

    const summary = summarizeFragmentImport(resultOf(plan), none, {
      dryRun: false,
      skipIndex: false,
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.lines).toContain("97 files: 97 unchanged · 0 refused · 0 warnings");
    expect(summary.lines.join("\n")).toContain("Nothing to import");
    expect(summary.lines.join("\n")).toContain("index=untouched");
    expect(summary.lines.some((l) => l.includes("f0.md"))).toBe(false);
  });

  it("exits 1 when any file is refused, and says which and why, by state", () => {
    const plan = [
      entry({ name: "ok.md" }),
      entry({ name: "bare.md", state: "no-id", message: "no frontmatter", turns: undefined }),
      entry({ name: "odd.md", state: "bad-date", message: "date is none of the forms" }),
    ];

    const summary = summarizeFragmentImport(resultOf(plan), none, {
      dryRun: true,
      skipIndex: false,
    });

    expect(summary.exitCode).toBe(1);
    expect(summary.lines).toContain("3 files: 1 new · 2 refused · 0 warnings");
    expect(summary.lines).toContain("  refused: 1 no-id · 1 bad-date");
    expect(summary.lines.join("\n")).toContain("bare.md · no frontmatter");
  });

  it("counts a file the CLI refused before asking, and the files that are not .md", () => {
    const summary = summarizeFragmentImport(
      resultOf([entry({ name: "a.md" })]),
      {
        refused: [{ name: "x.md", state: "unreadable", message: "not valid UTF-8" }],
        notMarkdown: 12,
      },
      { dryRun: true, skipIndex: false },
    );

    expect(summary.exitCode).toBe(1);
    expect(summary.lines).toContain("  12 files that are not .md were not read");
    expect(summary.lines).toContain("2 files: 1 new · 1 refused · 0 warnings");
  });

  it("counts warnings by kind, lists them under their file, and says how many files have no title", () => {
    const plan = [
      entry({
        name: "a.md",
        title: "",
        warnings: [{ code: "speakers-unknown-key", message: "speakers.break is not read" }],
      }),
      entry({
        name: "b.md",
        title: "",
        warnings: [{ code: "speakers-unknown-key", message: "speakers.lead is not read" }],
      }),
      entry({ name: "c.md" }),
    ];

    const summary = summarizeFragmentImport(resultOf(plan), none, {
      dryRun: false,
      skipIndex: false,
    });

    const text = summary.lines.join("\n");
    expect(summary.lines).toContain("3 files: 3 new · 0 refused · 2 warnings");
    expect(summary.lines).toContain("  warnings: speakers-unknown-key ×2");
    expect(text).toContain("speakers.break is not read");
    expect(text).toContain("2 files have no title");
    // a real import lists only the files that need a word
    expect(text).not.toContain("c.md");
    expect(summary.exitCode).toBe(0);
  });

  it("exits 1 when a chat failed to save or the index could not be updated, on a real import only", () => {
    const plan = [entry({ name: "a.md" })];
    expect(
      summarizeFragmentImport(resultOf(plan, { errors: 1 }), none, {
        dryRun: false,
        skipIndex: false,
      }).exitCode,
    ).toBe(1);
    const failed = summarizeFragmentImport(resultOf(plan, { indexError: "locked" }), none, {
      dryRun: false,
      skipIndex: false,
    });
    expect(failed.exitCode).toBe(1);
    expect(failed.lines.join("\n")).toContain("index=failed (locked)");
  });
});

describe("haevn import --format fragment", () => {
  const log = () => vi.spyOn(consola, "log").mockImplementation(() => undefined);

  async function run(args: Record<string, unknown>): Promise<void> {
    const runner = importCommand.run;
    if (!runner) throw new Error("no run function");
    await runner({
      args: {
        format: "fragment",
        file: dir,
        _: [],
        "no-overwrite": false,
        "skip-index": false,
        ...args,
      },
    } as unknown as Parameters<typeof runner>[0]);
  }

  beforeEach(() => {
    vi.mocked(daemonRequest).mockReset();
  });

  it("asks the extension for the plan on --dry-run, with the files as they are, and exits 0", async () => {
    write("a.md", `---\nid: ${ID}\n---\nwords\n`);
    vi.mocked(daemonRequest).mockResolvedValue(resultOf([entry({ name: path.join(dir, "a.md") })]));
    const output = log();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "dry-run": true });

    expect(daemonRequest).toHaveBeenCalledTimes(1);
    expect(daemonRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "import",
        format: "fragment",
        options: { overwrite: true, skipIndex: false, dryRun: true },
        files: [{ name: path.join(dir, "a.md"), content: `---\nid: ${ID}\n---\nwords\n` }],
      }),
    );
    expect(exit).not.toHaveBeenCalled();
    expect(output.mock.calls.join("\n")).toContain("1 file: 1 new");
  });

  it("exits 1 on a refusal, and still imports the others", async () => {
    write("a.md", "no frontmatter\n");
    write("b.md", `---\nid: ${ID}\n---\nwords\n`);
    vi.mocked(daemonRequest).mockResolvedValue(
      resultOf([
        entry({ name: path.join(dir, "a.md"), state: "no-id", message: "no frontmatter" }),
        entry({ name: path.join(dir, "b.md") }),
      ]),
    );
    log();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({});

    expect(daemonRequest).toHaveBeenCalledWith(
      expect.objectContaining({ options: { overwrite: true, skipIndex: false, dryRun: false } }),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("with --assign-ids asks for the plan, writes the id, then imports the file as written", async () => {
    const file = write("a.md", "just words\n");
    // what each request carried when it was sent: the payload array is the CLI's own, and changes after
    const sent: Array<{ dryRun: boolean; content: string }> = [];
    vi.mocked(daemonRequest).mockImplementation((async (request: {
      options: { dryRun: boolean };
      files: { content: string }[];
    }) => {
      sent.push({ dryRun: request.options.dryRun, content: request.files[0].content });
      return resultOf([
        entry({
          name: file,
          ...(request.options.dryRun ? { state: "no-id", turns: undefined } : {}),
        }),
      ]);
    }) as never);
    log();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "assign-ids": true });

    const written = fs.readFileSync(file, "utf8");
    expect(written).toMatch(/^---\nid: [0-9a-f-]{36}\n---\njust words\n$/);
    expect(sent).toEqual([
      { dryRun: true, content: "just words\n" },
      { dryRun: false, content: written },
    ]);
  });

  it("with --assign-ids --dry-run changes no file, and does not call the files without an id refused", async () => {
    const file = write("a.md", "just words\n");
    vi.mocked(daemonRequest).mockResolvedValue(
      resultOf([entry({ name: file, state: "no-id", turns: undefined })]),
    );
    const output = log();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "assign-ids": true, "dry-run": true });

    expect(fs.readFileSync(file, "utf8")).toBe("just words\n");
    expect(daemonRequest).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(output.mock.calls.join("\n")).toContain("would get a new id");
  });

  it("refuses --dry-run for any other format instead of importing for real", async () => {
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(
      run({ format: "pi", file: path.join(dir, "x.jsonl"), "dry-run": true }),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("only for --format fragment"));
    expect(daemonRequest).not.toHaveBeenCalled();
  });

  it("exits 1 with a sentence when the directory holds no .md file", async () => {
    write("notes.txt", "words");
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);

    await expect(run({})).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("No .md files found"));
    expect(daemonRequest).not.toHaveBeenCalled();
  });
});
