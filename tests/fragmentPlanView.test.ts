import { describe, expect, it } from "vitest";
import { gatherFragmentSources } from "../src/options/import/fragmentFiles";
import {
  assignIdsPlan,
  busyNotice,
  describeOutcome,
  describePlan,
  idBlock,
  idLine,
  indexesLater,
  inSentence,
  isMissingFrontmatter,
  leftOutLine,
  noIdWords,
  noMarkdownNotice,
  overLimitNotice,
  planHeading,
  readFailedNotice,
  replacedLine,
  shellWord,
} from "../src/options/import/fragmentPlanView";
import type { FragmentPlanEntry } from "../src/providers/fragment";
import { parseFragment } from "../src/providers/fragment";
import { INCREMENTAL_INDEX_MAX_CHATS } from "../src/utils/importLimits";

// HVN-163, slice 3: the words the Import dialog says about a plan and about what an import did.
// The design's table of states is /project/haevn/product/design/fragment-import.

const entry = (
  name: string,
  state: FragmentPlanEntry["state"],
  extra: Partial<FragmentPlanEntry> = {},
): FragmentPlanEntry => ({ name, state, warnings: [], ...extra });

const warn = (message: string) => [{ code: "copy" as const, message }];

const file = (name: string, size = 10) => {
  const f = new File(["x"], name);
  Object.defineProperty(f, "size", { value: size });
  return f;
};

describe("grouping a plan by what the person must do (HVN-163, slice 3)", () => {
  const plan: FragmentPlanEntry[] = [
    entry("new-1.md", "new", { title: "On rivers", turns: 14, date: "c. Mar 2024" }),
    entry("changed-1.md", "changed", { title: "Ghost", turns: 22, date: "2024" }),
    entry("unchanged-1.md", "unchanged"),
    entry("bad-date.md", "bad-date", { message: "date is none of the forms" }),
    entry("no-id.md", "no-id", { message: "the frontmatter has no id" }),
    entry("same.md", "same-file", { message: "same file as new-1.md" }),
    entry("new-2.md", "new", { turns: 1, date: "undated", warnings: warn("a copy of x") }),
    entry("latin1.md", "unreadable", { message: "not valid UTF-8" }),
    entry("dup.md", "duplicate-id", { message: "2 files share this id and they differ" }),
    entry("bad-id.md", "bad-id", { message: "id is not a UUID" }),
  ];

  it("puts the refused first, then new, changed, same file and unchanged", () => {
    const view = describePlan(plan, { replace: true });

    expect(view.groups.map((g) => [g.key, g.count])).toEqual([
      ["refused", 5],
      ["new", 2],
      ["changed", 1],
      ["same-file", 1],
      ["unchanged", 1],
    ]);
  });

  it("lists the refused in the CLI's order, with the plan's own reasons", () => {
    const refused = describePlan(plan, { replace: true }).groups[0];

    expect(refused.rows.map((r) => [r.label, r.name, r.reason])).toEqual([
      ["No id", "no-id.md", "the frontmatter has no id"],
      ["Bad id", "bad-id.md", "id is not a UUID"],
      ["Bad date", "bad-date.md", "date is none of the forms"],
      ["Unreadable", "latin1.md", "not valid UTF-8"],
      ["Duplicate id", "dup.md", "2 files share this id and they differ"],
    ]);
  });

  it("says title, turns and date for a fragment that will be saved, and sorts warnings first", () => {
    const fresh = describePlan(plan, { replace: true }).groups[1];

    expect(fresh.rows.map((r) => r.name)).toEqual(["new-2.md", "new-1.md"]);
    expect(fresh.rows[0]).toMatchObject({
      meta: "no title · 1 turn · undated",
      warnings: ["a copy of x"],
    });
    expect(fresh.rows[1].meta).toBe("On rivers · 14 turns · c. Mar 2024");
  });

  it("says an exact time in the archive's own format", () => {
    const view = describePlan(
      [entry("t.md", "new", { title: "T", turns: 2, date: "2024-03-15T14:30:00.000Z" })],
      { replace: true },
    );

    expect(view.groups[0].rows[0].meta).toBe(
      `T · 2 turns · ${new Date("2024-03-15T14:30:00.000Z").toLocaleString()}`,
    );
  });

  it("counts what is to be imported, and drops the changed when they are not replaced", () => {
    expect(describePlan(plan, { replace: true })).toMatchObject({
      toImport: 3,
      refusedCount: 5,
      unchangedCount: 1,
      sameFileCount: 1,
      warnedCount: 1,
      untitledCount: 1,
    });
    expect(describePlan(plan, { replace: false }).toImport).toBe(2);
  });

  it("counts a warning only on a file that would be written", () => {
    const view = describePlan(
      [
        entry("n.md", "new", { warnings: warn("a copy of x") }),
        entry("c.md", "changed", { warnings: warn("one side only") }),
        entry("u.md", "unchanged", { warnings: warn("a copy of y") }),
        entry("s.md", "same-file", { warnings: warn("a copy of z") }),
      ],
      { replace: true },
    );

    expect(view.warnedCount).toBe(2);
  });

  it("says how many new files have no title in the group's sentence", () => {
    const [group] = describePlan(
      [entry("a.md", "new"), entry("b.md", "new", { title: "B" }), entry("c.md", "new")],
      { replace: true },
    ).groups;

    expect(group.sentence).toBe(
      "Added to the archive. 2 have no title: shown as (Untitled) until metadata generation names them.",
    );
  });

  it("changes the refused sentence when nothing else can be imported", () => {
    const only = [entry("a.md", "no-id")];

    expect(describePlan(only, { replace: true }).groups[0].sentence).toBe(
      "Left out. The other files do not wait for them.",
    );
    expect(describePlan(only, { replace: true, allRefused: true }).groups[0].sentence).toBe(
      "Fix them and choose them again.",
    );
  });
});

describe("the heading and what was left out (HVN-163, slice 3)", () => {
  it("names the folder once, or says how many folders", () => {
    const one = gatherFragmentSources([{ kind: "folder", name: "recovered", entries: [] }]);
    const three = gatherFragmentSources(
      ["a", "b", "c"].map((name) => ({ kind: "folder" as const, name, entries: [] })),
    );
    const none = gatherFragmentSources([{ kind: "file", file: file("x.md") }]);

    expect(planHeading(486, one)).toBe("486 files from recovered/");
    expect(planHeading(486, three)).toBe("486 files from 3 folders");
    expect(planHeading(12, none)).toBe("12 files");
    expect(planHeading(1, none)).toBe("1 file");
  });

  it("splits a drop of a folder and loose files, counting .md files only", () => {
    const gathered = gatherFragmentSources([
      {
        kind: "folder",
        name: "walk-second",
        entries: ["a", "b", "c"].map((n) => ({ name: `${n}.md`, file: file(`${n}.md`) })),
      },
      { kind: "file", file: file("one.md") },
      { kind: "file", file: file("two.md") },
      { kind: "file", file: file("three.md") },
      { kind: "file", file: file("notes.txt") },
      { kind: "file", file: file("photo.jpg") },
    ]);

    expect(planHeading(gathered.candidates.length, gathered)).toBe(
      "6 files: 3 from walk-second/, 3 loose",
    );
  });

  it("says several folders and loose files the same way, and ignores loose files that are not .md", () => {
    const folderOf = (name: string) => ({
      kind: "folder" as const,
      name,
      entries: [{ name: "x.md", file: file("x.md") }],
    });
    const mixed = gatherFragmentSources([
      folderOf("a"),
      folderOf("b"),
      { kind: "file", file: file("one.md") },
    ]);
    const onlyText = gatherFragmentSources([folderOf("a"), { kind: "file", file: file("t.txt") }]);

    expect(planHeading(3, mixed)).toBe("3 files: 2 from 2 folders, 1 loose");
    expect(planHeading(1, onlyText)).toBe("1 file from a/");
  });

  it("says the files that are not .md and the folders inside, and is empty when nothing was left out", () => {
    const left = gatherFragmentSources([
      {
        kind: "folder",
        name: "recovered",
        entries: [
          { name: "a.md", file: file("a.md") },
          ...Array.from({ length: 12 }, (_, i) => ({ name: `n${i}.txt`, file: file(`n${i}.txt`) })),
          { name: "inner" },
        ],
      },
    ]);
    const clean = gatherFragmentSources([{ kind: "file", file: file("a.md") }]);

    expect(leftOutLine(left)).toBe(
      "12 files that are not .md were not read. 1 folder inside recovered/ was not read: a folder is read flat.",
    );
    expect(leftOutLine(clean)).toBe("");
  });

  it("names loose files that are left out", () => {
    const gathered = gatherFragmentSources([
      { kind: "file", file: file("notes.txt") },
      { kind: "file", file: file("a.md") },
    ]);

    expect(leftOutLine(gathered)).toBe("1 file that is not .md was not read: notes.txt.");
  });
});

describe("the notices (HVN-163, slice 3)", () => {
  it("says no .md files, with how many files were left out", () => {
    const texts = gatherFragmentSources([
      { kind: "folder", name: "t", entries: [{ name: "a.txt", file: file("a.txt") }] },
    ]);
    const empty = gatherFragmentSources([{ kind: "folder", name: "e", entries: [] }]);

    expect(noMarkdownNotice(texts)).toEqual({
      title: "No .md files here.",
      body: "1 file was left out: a fragment is a .md file. If one of them is a fragment, rename it to .md.",
    });
    expect(noMarkdownNotice(empty).body).toBe("The folder is empty.");
  });

  it("says the size in MB and the limit", () => {
    const gathered = gatherFragmentSources([
      { kind: "file", file: file("a.md", 24.5 * 1024 * 1024) },
    ]);

    expect(overLimitNotice(gathered)).toEqual({
      title: "Too much for one import.",
      body: "These 1 .md files hold 24.5 MB of text, and one import takes at most 16 MB. Choose fewer files at a time. Nothing was read.",
    });
  });

  it("names the operation that holds the lock in words", () => {
    expect(busyNotice("bulkSync").body).toContain("(bulk sync)");
    expect(busyNotice("import").body).toContain("(an import)");
    expect(busyNotice("bulkExport").body).toContain("(an export)");
    expect(busyNotice("bulkSync").title).toBe("Not imported.");
  });
});

describe("the command for the files that have no id (HVN-163, slice 3)", () => {
  it("names the folder when every such file came from the one folder given", () => {
    const noId = [
      { name: "a.md", folder: "recovered" },
      { name: "b.md", folder: "recovered" },
    ];

    expect(assignIdsPlan(noId, { folderIsEverything: true })).toEqual({
      command: "haevn import --format fragment --assign-ids recovered",
      folder: "recovered",
    });
  });

  it("names each file when they came from several places, and has no folder then", () => {
    expect(
      assignIdsPlan(
        [
          { name: "one/a.md", folder: "one" },
          { name: "b.md", folder: undefined },
        ],
        { folderIsEverything: false },
      ),
    ).toEqual({
      command: "haevn import --format fragment --assign-ids one/a.md b.md",
      folder: undefined,
    });
    expect(assignIdsPlan([{ name: "letters-1.md" }], { folderIsEverything: false })).toEqual({
      command: "haevn import --format fragment --assign-ids letters-1.md",
      folder: undefined,
    });
  });

  it("names a loose no-id file by its name, though a folder was dropped beside it", () => {
    // the walk's mixed drop: the one file without an id was loose
    const advice = assignIdsPlan([{ name: "loose-noid.md", folder: undefined }], {
      folderIsEverything: false,
    });

    expect(advice.command).toBe("haevn import --format fragment --assign-ids loose-noid.md");
    expect(noIdWords(1, advice.folder).where).not.toContain("walk-second");
  });

  it("says the folder form: it imports the folder, and where that folder is", () => {
    expect(noIdWords(2, "recovered")).toEqual({
      lead: "2 files have no id, and this page cannot write one into your files. In a terminal, this gives each of them an id and imports the folder:",
      where:
        "Run it in the folder that holds recovered/, or put the folder's full path in its place.",
    });
    expect(noIdWords(1, "recovered").lead).toBe(
      "1 file has no id, and this page cannot write one into your files. In a terminal, this gives it an id and imports the folder:",
    );
  });

  it("says the file form: it imports them (or it), and where the files are", () => {
    expect(noIdWords(2, undefined)).toEqual({
      lead: "2 files have no id, and this page cannot write one into your files. In a terminal, this gives each of them an id and imports them:",
      where: "Run it in the folder that holds these files, or give each its full path.",
    });
    expect(noIdWords(1, undefined)).toEqual({
      lead: "1 file has no id, and this page cannot write one into your files. In a terminal, this gives it an id and imports it:",
      where: "Run it in the folder that holds this file, or give its full path.",
    });
  });

  it("puts a name with anything outside A-Za-z0-9._/- in single quotes", () => {
    expect(shellWord("a-b_c.d/e.md")).toBe("a-b_c.d/e.md");
    expect(shellWord("my file.md")).toBe("'my file.md'");
    expect(shellWord("it's.md")).toBe("'it'\\''s.md'");
    expect(shellWord("a$(x).md")).toBe("'a$(x).md'");
    expect(shellWord("é.md")).toBe("'é.md'");
  });

  it("makes a fresh id line each time, a v4 UUID", () => {
    const a = idLine();
    const b = idLine();

    expect(a).toMatch(/^id: [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it("gives a file with no frontmatter the whole block, with a fresh id in it", () => {
    const block = idBlock("11111111-1111-4111-8111-111111111111");

    expect(block).toBe("---\nid: 11111111-1111-4111-8111-111111111111\n---\n");
    expect(idBlock()).not.toBe(idBlock());
  });

  it("knows a file with no frontmatter by the parser's own reason, and no other", () => {
    const reason = (text: string) => {
      const outcome = parseFragment({ name: "x.md", content: text });
      return outcome.ok ? undefined : outcome.message;
    };

    expect(isMissingFrontmatter(reason("just a chat, no fence\n"))).toBe(true);
    expect(isMissingFrontmatter(reason("---\ntitle: T\n---\nbody\n"))).toBe(false);
    expect(isMissingFrontmatter(undefined)).toBe(false);
  });
});

describe("an error message in a sentence, and a read that failed (HVN-163, slice 3)", () => {
  it("drops its full stop, and its capital when the word is an ordinary one", () => {
    expect(inSentence("Could not establish connection. Receiving end does not exist.")).toBe(
      "could not establish connection. Receiving end does not exist",
    );
    expect(inSentence("The database is closed.")).toBe("the database is closed");
    expect(inSentence("IndexedDB failed.")).toBe("IndexedDB failed");
    expect(inSentence("HTTP 500")).toBe("HTTP 500");
    expect(inSentence("")).toBe("");
  });

  it("says the files could not be read and that nothing was written, without Chrome's words", () => {
    const notice = readFailedNotice();
    expect(notice.title).toBe("The files could not be read.");
    expect(notice.body).toMatch(/^Chrome could not open a file or folder you chose/);
    expect(notice.body).toMatch(/Nothing was written\.$/);
    expect(notice.body).not.toMatch(/write to a file/);
  });
});

describe("what a growing set says (HVN-179)", () => {
  it("says the files that replaced an earlier one, five of them at most", () => {
    expect(replacedLine([])).toBe("");
    expect(replacedLine(["a.md"])).toBe("1 file was added twice; the later copy is used: a.md.");
    expect(replacedLine(["a.md", "notes/1.md"])).toBe(
      "2 files were added twice; the later copies are used: a.md, notes/1.md.",
    );
    expect(replacedLine(["1", "2", "3", "4", "5", "6", "7"].map((n) => `${n}.md`))).toBe(
      "7 files were added twice; the later copies are used: 1.md, 2.md, 3.md, 4.md, 5.md and 2 more.",
    );
  });

  it("says a drop was not added, and that the files already there are kept", () => {
    const over = gatherFragmentSources([{ kind: "file", file: file("a.md", 17 * 1024 * 1024) }]);

    expect(overLimitNotice(over, 3)).toEqual({
      title: "Not added: too much for one import.",
      body: "With them, the set would be 1 .md files and 17.0 MB, and one import takes at most 16 MB. The 3 files already here are kept: import them first, or Clear and choose fewer.",
    });
    expect(overLimitNotice(over, 1).body).toContain(
      "The 1 file already here is kept: import it first",
    );
    expect(overLimitNotice(over).body).toContain("Nothing was read.");
  });

  it("says a drop with no .md file left the plan as it was", () => {
    const texts = gatherFragmentSources([{ kind: "file", file: file("a.txt") }]);

    expect(noMarkdownNotice(texts, true).body).toBe(
      "1 file was left out: a fragment is a .md file. If one of them is a fragment, rename it to .md. The files already here are as they were.",
    );
    expect(noMarkdownNotice(texts).body).not.toContain("already here");
  });
});

describe("when search catches up (HVN-163, slice 3)", () => {
  it("counts the new and the changed together, as the batch does, whether they are replaced or not", () => {
    const edge = INCREMENTAL_INDEX_MAX_CHATS;

    expect(indexesLater({ newCount: edge, changedCount: 0 })).toBe(false);
    expect(indexesLater({ newCount: edge, changedCount: 1 })).toBe(true);
    expect(indexesLater({ newCount: 0, changedCount: edge + 1 })).toBe(true);
    expect(indexesLater({ newCount: 3, changedCount: 3 })).toBe(false);
  });
});

describe("what an import did (HVN-163, slice 3)", () => {
  const plan = [
    entry("a.md", "new", { title: "A" }),
    entry("b.md", "new"),
    entry("c.md", "changed", { title: "C" }),
    entry("d.md", "changed"),
    entry("e.md", "unchanged"),
    entry("f.md", "no-id"),
  ];

  it("counts new, replaced and unchanged from the plan the service made, and the refused", () => {
    const outcome = describeOutcome(
      { plan, imported: { processed: 4, saved: 4, skipped: 0, errors: 0, failed: [] } },
      { replace: true },
    );

    expect(outcome).toMatchObject({
      saved: 4,
      attempted: 4,
      newSaved: 2,
      replaced: 2,
      leftAsIs: 0,
      unchanged: 1,
      refused: 1,
      untitled: 2,
      failed: [],
    });
  });

  it("takes the files that failed out of the counts, and names them", () => {
    const outcome = describeOutcome(
      {
        plan,
        imported: {
          processed: 4,
          saved: 2,
          skipped: 0,
          errors: 2,
          failed: [
            { name: "b.md", message: "disk full" },
            { name: "c.md", message: "disk full" },
          ],
        },
      },
      { replace: true },
    );

    expect(outcome).toMatchObject({
      saved: 2,
      attempted: 4,
      newSaved: 1,
      replaced: 1,
      untitled: 1, // only d.md: b.md did not get in
    });
    expect(outcome.failed.map((f) => f.name)).toEqual(["b.md", "c.md"]);
  });

  it("says the changed files were left as they are when they were not replaced", () => {
    const outcome = describeOutcome(
      { plan, imported: { processed: 4, saved: 2, skipped: 2, errors: 0, failed: [] } },
      { replace: false },
    );

    expect(outcome).toMatchObject({ newSaved: 2, replaced: 0, leftAsIs: 2, attempted: 2 });
  });

  it("does not count a changed file that failed as left as it is as well", () => {
    const outcome = describeOutcome(
      {
        plan,
        imported: {
          processed: 4,
          saved: 1,
          skipped: 1,
          errors: 1,
          failed: [{ name: "c.md", message: "load failed" }],
        },
      },
      { replace: false },
    );

    // c.md failed to load, so only d.md was left as it is: c.md is not counted twice
    expect(outcome.leftAsIs).toBe(1);
    expect(outcome.failed.map((f) => f.name)).toEqual(["c.md"]);
  });

  it("carries the index's failure", () => {
    const outcome = describeOutcome(
      {
        plan,
        imported: {
          processed: 4,
          saved: 4,
          skipped: 0,
          errors: 0,
          failed: [],
          indexError: "the index is rebuilding",
        },
      },
      { replace: true },
    );

    expect(outcome.indexError).toBe("the index is rebuilding");
  });

  it("has nothing saved when the service found nothing to import", () => {
    const outcome = describeOutcome({ plan: [entry("e.md", "unchanged")] }, { replace: true });

    expect(outcome).toMatchObject({ saved: 0, attempted: 0, unchanged: 1 });
  });
});
