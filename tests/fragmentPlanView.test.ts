import { describe, expect, it } from "vitest";
import type { FragmentPlanEntry } from "../src/providers/fragment";
import { gatherFragmentSources } from "../src/options/import/fragmentFiles";
import {
  assignIdsCommand,
  busyNotice,
  describeOutcome,
  describePlan,
  idLine,
  leftOutLine,
  noMarkdownNotice,
  overLimitNotice,
  planHeading,
  shellWord,
} from "../src/options/import/fragmentPlanView";

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
  it("names the folder when every such file came from one folder", () => {
    const noId = [
      { name: "a.md", folder: "recovered" },
      { name: "b.md", folder: "recovered" },
    ];

    expect(assignIdsCommand(noId, { folderIsEverything: true })).toBe(
      "haevn import --format fragment --assign-ids recovered",
    );
  });

  it("names each file when they came from several places", () => {
    expect(
      assignIdsCommand(
        [
          { name: "one/a.md", folder: "one" },
          { name: "b.md", folder: undefined },
        ],
        { folderIsEverything: false },
      ),
    ).toBe("haevn import --format fragment --assign-ids one/a.md b.md");
    expect(assignIdsCommand([{ name: "letters-1.md" }], { folderIsEverything: false })).toBe(
      "haevn import --format fragment --assign-ids letters-1.md",
    );
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
