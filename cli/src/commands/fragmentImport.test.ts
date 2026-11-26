import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import type { FragmentPlanEntry, ImportResult } from "../types";
import { consola } from "../utils/output";
import {
  type AskExtension,
  assignId,
  assignIds,
  collectFragmentFiles,
  summarizeFragmentImport,
  whyNoId,
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

  it("counts a symlink in a directory and leaves it, and reads through one named outright", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-fragments-outside-"));
    try {
      const target = path.join(outside, "target.md");
      fs.writeFileSync(target, "target words\n");
      write("real.md", "real");
      fs.symlinkSync(target, path.join(dir, "link.md"));

      const inDirectory = await collectFragmentFiles([dir]);
      const named = await collectFragmentFiles([path.join(dir, "link.md")]);

      expect(inDirectory.files.map((f) => path.basename(f.name))).toEqual(["real.md"]);
      expect(inDirectory.symlinks).toBe(1);
      expect(named.files.map((f) => f.content)).toEqual(["target words\n"]);
      // an id would be written to what the link points at
      expect(named.paths.get(path.join(dir, "link.md"))).toBe(fs.realpathSync(target));
      expect(named.symlinks).toBe(0);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
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
});

/**
 * A stand-in for the extension's plan, with the few of its rules these cases need: an `id:` line
 * makes a file `new`, a blank body is `unreadable`, `BADDATE` in the frontmatter is `bad-date`.
 * The real planner is held to the CLI's rules in tests/fragmentAssignIds.test.ts.
 */
function fakePlan(files: { name: string; content: string }[]): FragmentPlanEntry[] {
  return files.map(({ name, content }) => {
    const bodyOf = content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/, "");
    if (!/^id: [0-9a-f-]{36}\r?$/m.test(content)) {
      return { name, state: "no-id", warnings: [], message: "the frontmatter has no id" };
    }
    if (content.includes("BADDATE")) {
      return { name, state: "bad-date", warnings: [], message: "date is not a date" };
    }
    if (bodyOf.trim() === "") {
      return { name, state: "unreadable", warnings: [], message: "the body is empty" };
    }
    return { name, state: "new", warnings: [], title: "T", turns: 1, date: "2024" };
  });
}

function fakeAsk(onAsk?: (files: { name: string; content: string }[], planOnly: boolean) => void) {
  const asked: { planOnly: boolean; contents: string[] }[] = [];
  const ask: AskExtension = async (files, planOnly) => {
    asked.push({ planOnly, contents: files.map((f) => f.content) });
    onAsk?.(files, planOnly);
    return resultOf(fakePlan(files));
  };
  return { ask, asked };
}

describe("--assign-ids decides after the plan's other checks, and writes with care", () => {
  const body = "A body\n";
  const states = (result: ImportResult) =>
    (result.plan ?? []).map((e) => [path.basename(e.name), e.state] as const);

  it("writes an id to the files the plan then accepts, and to no other", async () => {
    const bare = write("1-bare.md", body);
    const titled = write("2-titled.md", "---\ntitle: T\n---\nwords\n");
    const blank = write("3-blank.md", "\n  \n");
    const badDate = write("4-baddate.md", "---\ndate: BADDATE\n---\nwords\n");
    const flow = write("5-flow.md", "---\n{ title: Flow }\n---\nwords\n");
    const indented = write("6-indented.md", "---\n  title: Indented\n---\nwords\n");
    const named = write("7-named.md", `---\nid: ${ID}\n---\nwords\n`);
    const input = await collectFragmentFiles([dir]);
    const { ask } = fakeAsk();

    const { result, assigned } = await assignIds(input, ask, false);

    expect(assigned.map((a) => path.basename(a.name))).toEqual(["1-bare.md", "2-titled.md"]);
    expect(fs.readFileSync(bare, "utf8")).toBe(`---\nid: ${assigned[0].id}\n---\n${body}`);
    expect(fs.readFileSync(titled, "utf8")).toBe(
      `---\nid: ${assigned[1].id}\ntitle: T\n---\nwords\n`,
    );
    // left exactly as they were
    expect(fs.readFileSync(blank, "utf8")).toBe("\n  \n");
    expect(fs.readFileSync(badDate, "utf8")).toBe("---\ndate: BADDATE\n---\nwords\n");
    expect(fs.readFileSync(flow, "utf8")).toBe("---\n{ title: Flow }\n---\nwords\n");
    expect(fs.readFileSync(indented, "utf8")).toBe("---\n  title: Indented\n---\nwords\n");
    expect(fs.readFileSync(named, "utf8")).toBe(`---\nid: ${ID}\n---\nwords\n`);
    expect(assigned[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // the files that are sent next carry the ids, and the plan says why the others have none
    expect(input.files.find((f) => f.name === bare)?.content).toContain(`id: ${assigned[0].id}`);
    expect(states(result)).toEqual([
      ["1-bare.md", "new"],
      ["2-titled.md", "new"],
      ["3-blank.md", "no-id"],
      ["4-baddate.md", "no-id"],
      ["5-flow.md", "no-id"],
      ["6-indented.md", "no-id"],
      ["7-named.md", "new"],
    ]);
    const why = (name: string) => result.plan?.find((e) => e.name.endsWith(name))?.message;
    expect(why("3-blank.md")).toContain("refused as unreadable");
    expect(why("4-baddate.md")).toContain("refused as bad-date");
    expect(why("5-flow.md")).toContain("put one in by hand");
    expect(why("6-indented.md")).toContain("left margin");
    // no temporary file is left behind
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("makes the same decisions with --dry-run, writes nothing, and the real run agrees", async () => {
    write("1-bare.md", body);
    write("2-blank.md", "\n");
    write("3-flow.md", "---\n[ a ]\n---\nwords\n");
    const before = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8"));

    const dryInput = await collectFragmentFiles([dir]);
    const dry = await assignIds(dryInput, fakeAsk().ask, true);

    expect(fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), "utf8"))).toEqual(
      before,
    );
    expect(dryInput.files.map((f) => f.content)).toEqual(before);
    expect(dry.assigned.map((a) => path.basename(a.name))).toEqual(["1-bare.md"]);
    expect(dry.result.plan?.find((e) => e.name.endsWith("1-bare.md"))?.message).toBe(
      "would get a new id",
    );

    const realInput = await collectFragmentFiles([dir]);
    const real = await assignIds(realInput, fakeAsk().ask, false);

    expect(states(real.result)).toEqual(states(dry.result));
    expect(real.assigned.map((a) => path.basename(a.name))).toEqual(
      dry.assigned.map((a) => path.basename(a.name)),
    );
  });

  it("says in a dry run that a read-only file would get no id, as the real run does", async () => {
    write("1-ok.md", body);
    const readOnly = write("2-ro.md", body);
    fs.chmodSync(readOnly, 0o444);
    const dry = await assignIds(await collectFragmentFiles([dir]), fakeAsk().ask, true);
    const real = await assignIds(await collectFragmentFiles([dir]), fakeAsk().ask, false);

    expect(states(dry.result)).toEqual(states(real.result));
    expect(dry.assigned.map((a) => path.basename(a.name))).toEqual(["1-ok.md"]);
    expect(dry.result.plan?.find((e) => e.name.endsWith("2-ro.md"))?.message).toContain(
      "read-only",
    );
  });

  it("asks the extension three times for a real run (the plan, the plan with ids, the import), and once more for none", async () => {
    write("a.md", body);
    const input = await collectFragmentFiles([dir]);
    const { ask, asked } = fakeAsk();

    await assignIds(input, ask, false);

    expect(asked.map((a) => a.planOnly)).toEqual([true, true, false]);
    // the plan with ids carried the id, the first plan did not, and the import carries the file as written
    expect(asked[0].contents[0]).toBe(body);
    expect(asked[1].contents[0]).toMatch(/^---\nid: [0-9a-f-]{36}\n---\n/);
    expect(asked[2].contents[0]).toBe(asked[1].contents[0]);
  });

  it("keeps the mode of a file exactly, the umask not applied", async () => {
    const file = write("a.md", body);
    fs.chmodSync(file, 0o664);
    const input = await collectFragmentFiles([dir]);

    await assignIds(input, fakeAsk().ask, false);

    expect(fs.statSync(file).mode & 0o7777).toBe(0o664);
    expect(fs.readFileSync(file, "utf8")).toContain("id: ");
  });

  it("leaves a read-only file as it is, and says so", async () => {
    const file = write("a.md", body);
    fs.chmodSync(file, 0o444);
    const input = await collectFragmentFiles([dir]);

    const { result, assigned } = await assignIds(input, fakeAsk().ask, false);

    expect(assigned).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(body);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o444);
    expect(result.plan?.[0]).toMatchObject({ state: "no-id" });
    expect(result.plan?.[0].message).toContain("read-only");
    // and the file the import is then asked about has no id
    expect(input.files[0].content).toBe(body);
  });

  it("writes through a symlink named outright, to its target, and leaves the link a link", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-fragments-outside-"));
    try {
      const target = path.join(outside, "target.md");
      fs.writeFileSync(target, body);
      const link = path.join(dir, "link.md");
      fs.symlinkSync(target, link);
      const input = await collectFragmentFiles([link]);

      const { assigned } = await assignIds(input, fakeAsk().ask, false);

      expect(assigned).toHaveLength(1);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, "utf8")).toBe(`---\nid: ${assigned[0].id}\n---\n${body}`);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write over a file that changed after it was read, and the edit stays", async () => {
    const file = write("a.md", body);
    const input = await collectFragmentFiles([dir]);
    // the person saves the file while the plan with ids is being made
    const { ask } = fakeAsk((_files, planOnly) => {
      if (planOnly && fs.readFileSync(file, "utf8") === body)
        fs.writeFileSync(file, "edited by hand\n");
    });

    const { result, assigned } = await assignIds(input, ask, false);

    expect(assigned).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("edited by hand\n");
    expect(result.plan?.[0]).toMatchObject({ state: "no-id" });
    expect(result.plan?.[0].message).toContain("changed after it was read");
    expect(fs.readdirSync(dir)).toEqual(["a.md"]);
  });
});

describe("whyNoId: where the id: line cannot go", () => {
  it.each([
    ["no block", "words\n"],
    ["a block that is never closed", "---\nwords\n"],
    ["an empty block", "---\n---\nwords\n"],
    ["a block of comments", "---\n# only a note\n---\nwords\n"],
    ["a plain key", "---\ntitle: T\n---\nwords\n"],
    ["a comment, then a key", "---\n# note\n\ntitle: T\n---\nwords\n"],
    ["a quoted key", '---\n"a key": v\n---\nwords\n'],
    ["a key with nothing after it", "---\ntags:\n  - a\n---\nwords\n"],
    ["CRLF", "---\r\ntitle: T\r\n---\r\nwords\r\n"],
    ["a byte-order mark", "﻿---\ntitle: T\n---\nwords\n"],
  ])("accepts %s", (_label, content) => {
    expect(whyNoId(content)).toBeUndefined();
  });

  it.each([
    ["a flow map", "---\n{ title: T }\n---\nwords\n"],
    ["a flow sequence", "---\n[a, b]\n---\nwords\n"],
    ["an indented block", "---\n  title: T\n---\nwords\n"],
    ["a list", "---\n- a\n- b\n---\nwords\n"],
    ["a plain line", "---\njust some words\n---\nwords\n"],
  ])("refuses %s, with the way out", (_label, content) => {
    expect(whyNoId(content)).toContain("put one in by hand");
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

  it("says how many symlinks of a directory were not read", () => {
    const out = summarizeFragmentImport(
      resultOf([entry({ name: "a.md" })]),
      { ...none, symlinks: 2 },
      { dryRun: false, skipIndex: false },
    ).lines.join("\n");
    expect(out).toContain("2 symlinks in a directory were not read");
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
        warnings: [{ code: "speakers-unknown-key", message: "speakers.asistant is not read" }],
      }),
      entry({
        name: "b.md",
        title: "",
        warnings: [{ code: "speakers-unknown-key", message: "speakers.leed is not read" }],
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
    expect(text).toContain("speakers.asistant is not read");
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

  /** The daemon, answering with the stand-in plan, and remembering what each request carried when it was sent. */
  function planningDaemon() {
    const sent: Array<{ dryRun: boolean; content: string }> = [];
    vi.mocked(daemonRequest).mockImplementation((async (request: {
      options: { dryRun: boolean };
      files: { name: string; content: string }[];
    }) => {
      sent.push({ dryRun: request.options.dryRun, content: request.files[0].content });
      return resultOf(fakePlan(request.files));
    }) as never);
    return sent;
  }

  it("with --assign-ids asks for the plan, then the plan with the id, writes it, and imports the file as written", async () => {
    const file = write("a.md", "just words\n");
    const sent = planningDaemon();
    log();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "assign-ids": true });

    const written = fs.readFileSync(file, "utf8");
    expect(written).toMatch(/^---\nid: [0-9a-f-]{36}\n---\njust words\n$/);
    expect(sent).toEqual([
      { dryRun: true, content: "just words\n" },
      { dryRun: true, content: written },
      { dryRun: false, content: written },
    ]);
  });

  it("with --assign-ids --dry-run changes no file, and does not call the files without an id refused", async () => {
    const file = write("a.md", "just words\n");
    planningDaemon();
    const output = log();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "assign-ids": true, "dry-run": true });

    expect(fs.readFileSync(file, "utf8")).toBe("just words\n");
    expect(daemonRequest).toHaveBeenCalledTimes(2);
    expect(exit).not.toHaveBeenCalled();
    expect(output.mock.calls.join("\n")).toContain("would get a new id");
  });

  it("with --assign-ids leaves a file that could not be imported anyway as it is, and exits 1 saying why", async () => {
    const blank = write("blank.md", "\n");
    planningDaemon();
    const output = log();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    await run({ "assign-ids": true });

    expect(fs.readFileSync(blank, "utf8")).toBe("\n");
    expect(exit).toHaveBeenCalledWith(1);
    const printed = output.mock.calls.join("\n");
    expect(printed).toContain("no id was added");
    expect(printed).toContain("refused as unreadable");
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
