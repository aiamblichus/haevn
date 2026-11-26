import { describe, expect, it } from "vitest";
import { assignId } from "../cli/src/commands/fragmentImport";
import { parseFragment } from "../src/providers/fragment";

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
