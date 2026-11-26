import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AskExtension,
  assignId,
  assignIds,
  collectFragmentFiles,
  whyNoId,
} from "../cli/src/commands/fragmentImport";
import { parseFragment, planFragmentImport } from "../src/providers/fragment";
import { emptyLookup } from "./helpers/fragmentFile";

// HVN-163: the CLI finds a file's frontmatter with its own few lines (it has no YAML reader and
// imports nothing from the extension), and the extension's parser finds it with its own. Both must
// find the same block, or `--assign-ids` writes an id the plan then cannot read. Here each file is
// given an id by the CLI's rule and read by the extension's parser.

const ID = "0d1b3f58-9c2e-4e7a-8a61-5c4f2b9d7e10";

interface Case {
  label: string;
  content: string;
  /** What the body is, before and after the id: a file that has a block keeps its body, any other is all body */
  body: string;
  /** The id line goes into the block that is there (true) or in a block in front of the file (false) */
  hasBlock: boolean;
}

const cases: Case[] = [
  {
    label: "no frontmatter",
    content: "Just words\nand more\n",
    body: "Just words\nand more\n",
    hasBlock: false,
  },
  {
    label: "a rule at the top that is never closed",
    content: "---\nwords after a rule\n",
    body: "---\nwords after a rule\n",
    hasBlock: false,
  },
  {
    label: "frontmatter with no id",
    content: "---\ntitle: T\nmodel: m\n---\nBody\n",
    body: "Body\n",
    hasBlock: true,
  },
  {
    label: "frontmatter with a YAML comment",
    content: "---\n# a guess, not a fact\ntitle: T\n---\nBody\n",
    body: "Body\n",
    hasBlock: true,
  },
  { label: "an empty block", content: "---\n---\nBody\n", body: "Body\n", hasBlock: true },
  {
    label: "CRLF line endings",
    content: "---\r\ntitle: T\r\n---\r\nBody\r\nmore\r\n",
    body: "Body\r\nmore\r\n",
    hasBlock: true,
  },
  {
    label: "CRLF and no frontmatter",
    content: "first\r\nsecond\r\n",
    body: "first\r\nsecond\r\n",
    hasBlock: false,
  },
  {
    label: "a byte-order mark and frontmatter",
    content: "﻿---\ntitle: T\n---\nBody\n",
    body: "Body\n",
    hasBlock: true,
  },
  {
    label: "a rule inside the body",
    content: "---\ntitle: T\n---\nBody\n---\nafter the rule\n",
    body: "Body\n---\nafter the rule\n",
    hasBlock: true,
  },
  {
    label: "a body that starts with a rule",
    content: "---\ntitle: T\n---\n---\nthe body starts with a rule\n",
    body: "---\nthe body starts with a rule\n",
    hasBlock: true,
  },
  {
    label: "a closing fence with trailing spaces",
    content: "---\ntitle: T\n---  \nBody\n",
    body: "Body\n",
    hasBlock: true,
  },
  { label: "no final newline", content: "---\ntitle: T\n---\nBody", body: "Body", hasBlock: true },
];

describe("--assign-ids gives a file the id the parser then reads (HVN-163)", () => {
  it.each(cases)("$label", ({ content, body, hasBlock }) => {
    // the file as it is has no id
    expect(parseFragment({ name: "f.md", content })).toMatchObject({ ok: false, state: "no-id" });

    const assigned = assignId(content, ID);
    const outcome = parseFragment({ name: "f.md", content: assigned });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fragment.id).toBe(ID);
    // the body is the body it was
    expect(outcome.fragment.body).toBe(body);
    // and only the id line was written: take it out and the file is what it was
    const without = assigned.replace(/id: [0-9a-f-]{36}\r?\n/, "");
    expect(hasBlock ? without : without.replace(/^---\r?\n---\r?\n/, "")).toBe(content);
  });
});

describe("whyNoId agrees with the parser about where an id: line can go (HVN-163)", () => {
  // Each file has no id. The id line is put in by the CLI's rule when whyNoId says it can go, and
  // the parser must then read the file; when whyNoId says it cannot, the line would break it.
  const files: [string, string][] = [
    ["a plain key", "---\ntitle: T\n---\nBody\n"],
    ["a quoted key", '---\n"a key": v\n---\nBody\n'],
    ["a key with a list under it", "---\ntags:\n  - a\n---\nBody\n"],
    ["comments first", "---\n# one\n\n# two\ntitle: T\n---\nBody\n"],
    ["an empty block", "---\n---\nBody\n"],
    ["no block", "Body\n"],
    ["a flow map", "---\n{ title: T }\n---\nBody\n"],
    ["a flow sequence", "---\n[a, b]\n---\nBody\n"],
    ["an indented block", "---\n  title: T\n---\nBody\n"],
    ["a list", "---\n- a\n- b\n---\nBody\n"],
    ["a plain line", "---\njust some words\n---\nBody\n"],
  ];

  it.each(files)("%s", (_label, content) => {
    const assigned = parseFragment({
      name: "f.md",
      content: assignId(content, "0d1b3f58-9c2e-4e7a-8a61-5c4f2b9d7e10"),
    });
    expect(whyNoId(content) === undefined).toBe(assigned.ok);
  });
});

describe("--assign-ids against the real plan (HVN-163)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "haevn-assign-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) => {
    fs.writeFileSync(path.join(dir, name), content);
    return path.join(dir, name);
  };

  /** The extension's own planner, as the bridge would answer for the files it is sent. */
  const ask: AskExtension = async (files) => {
    const { entries } = await planFragmentImport(files, emptyLookup);
    return {
      format: "fragment",
      total: files.length,
      processed: 0,
      saved: 0,
      skipped: 0,
      errors: 0,
      plan: entries,
    };
  };

  const files = {
    "1-bare.md": "A bare body\n",
    "2-titled.md": "---\ntitle: T\ndate: 2024-03\n---\nWords\n",
    "3-blank.md": "\n\n",
    "4-baddate.md": "---\ndate: sometime in March\n---\nWords\n",
    "5-flow.md": "---\n{ title: Flow }\n---\nWords\n",
    "6-comment-only.md": "---\n# nothing here yet\n---\nWords\n",
  };

  it("writes an id only to the files the plan accepts with it, and a dry run says the same", async () => {
    for (const [name, content] of Object.entries(files)) write(name, content);

    const dryInput = await collectFragmentFiles([dir]);
    const dry = await assignIds(dryInput, ask, true);
    for (const [name, content] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe(content);
    }

    const realInput = await collectFragmentFiles([dir]);
    const real = await assignIds(realInput, ask, false);

    const states = (r: typeof real) => r.result.plan?.map((e) => [path.basename(e.name), e.state]);
    expect(states(real)).toEqual(states(dry));
    expect(states(real)).toEqual([
      ["1-bare.md", "new"],
      ["2-titled.md", "new"],
      ["3-blank.md", "no-id"],
      ["4-baddate.md", "no-id"],
      ["5-flow.md", "no-id"],
      ["6-comment-only.md", "new"],
    ]);
    // what was written, and what was not
    const onDisk = (name: string) => fs.readFileSync(path.join(dir, name), "utf8");
    for (const name of ["1-bare.md", "2-titled.md", "6-comment-only.md"]) {
      expect(onDisk(name)).toMatch(/\nid: [0-9a-f-]{36}\n/);
      expect(onDisk(name)).not.toBe(files[name as keyof typeof files]);
    }
    for (const name of ["3-blank.md", "4-baddate.md", "5-flow.md"]) {
      expect(onDisk(name)).toBe(files[name as keyof typeof files]);
    }
    // and a plain second run of the files as they are now has every written file importable
    const again = await ask((await collectFragmentFiles([dir])).files, true);
    expect(again.plan?.filter((e) => e.state === "new").length).toBe(3);
  });
});
