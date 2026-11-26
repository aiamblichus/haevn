import { describe, expect, it } from "vitest";
import {
  type FragmentWarning,
  parseFragment,
  reassembleFragment,
  transformFragmentToHaevnChat,
} from "../src/providers/fragment";
import { fragmentFile, ID_A, parsed, withId } from "./helpers/fragmentFile";

// HVN-163: the fragment parser, by table. No text of any real chat is here: every body is made up.

function parseOk(file: { name: string; content: string }) {
  const outcome = parseFragment(file);
  if (!outcome.ok) throw new Error(`refused: ${outcome.state} (${outcome.message})`);
  return outcome.fragment;
}

function turnsOf(extra: string, body: string) {
  return parseOk(withId(extra, body)).turns.map((turn) => [turn.role, turn.text]);
}

function codes(warnings: FragmentWarning[]): string[] {
  return warnings.map((w) => w.code);
}

describe("a file that is refused", () => {
  const refused: Array<[string, string, string]> = [
    ["no frontmatter", "just words\n", "no-id"],
    ["a fence that is never closed", `---\nid: ${ID_A}\nwords\n`, "no-id"],
    ["frontmatter with no id", "---\ntitle: A poem\n---\nwords\n", "no-id"],
    ["an empty frontmatter block", "---\n---\nwords\n", "no-id"],
    ["an id key with no value", "---\nid:\n---\nwords\n", "bad-id"],
    ["an id that is not a UUID", "---\nid: ghost-poems-03\n---\nwords\n", "bad-id"],
    ["an id that is a number", "---\nid: 42\n---\nwords\n", "bad-id"],
    ["an id one digit short", `---\nid: ${ID_A.slice(1)}\n---\nwords\n`, "bad-id"],
    ["a date in no form", `---\nid: ${ID_A}\ndate: March\n---\nwords\n`, "bad-date"],
    ["YAML that does not parse", `---\nid: ${ID_A}\ntitle: [unclosed\n---\nwords\n`, "unreadable"],
    ["a key twice", `---\nid: ${ID_A}\nid: ${ID_A}\n---\nwords\n`, "unreadable"],
    ["a frontmatter that is a list", "---\n- one\n- two\n---\nwords\n", "unreadable"],
    ["an empty body", `---\nid: ${ID_A}\n---\n`, "unreadable"],
    ["a body of white space", `---\nid: ${ID_A}\n---\n \n\t\n`, "unreadable"],
  ];

  it.each(refused)("%s", (_label, content, state) => {
    const outcome = parseFragment({ name: "f.md", content });
    expect(outcome).toMatchObject({ ok: false, state });
  });

  it("says where a YAML error is, and does not quote the file", () => {
    const outcome = parseFragment({
      name: "f.md",
      content: `---\nid: ${ID_A}\ntitle: [secret words\n---\nwords\n`,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.message).toMatch(/^frontmatter is not valid YAML/);
      expect(outcome.message).not.toContain("secret");
    }
  });
});

describe("a file that is read", () => {
  it("takes the id in any case and keeps it lower-cased", () => {
    expect(parseOk(withId("", "words\n", ID_A.toUpperCase())).id).toBe(ID_A);
  });

  it("reads a byte-order mark and CRLF line endings", () => {
    const crlf = `﻿---\r\nid: ${ID_A}\r\ntitle: Kept\r\n---\r\nfirst\r\nsecond\r\n`;
    const fragment = parseOk({ name: "f.md", content: crlf });
    expect(fragment.fields.title).toBe("Kept");
    expect(fragment.body).toBe("first\r\nsecond\r\n");
    expect(fragment.turns).toEqual([{ role: null, text: "first\r\nsecond" }]);
    expect(fragment.tail).toBe("\r\n");
  });

  it("reads the worked example of the design as the design says", () => {
    const fragment = parseOk(
      fragmentFile(
        [
          `id: ${ID_A}`,
          "title: The lighthouse keeper",
          "model: claude-3-opus",
          "date: ~2024-03",
          "platform: poe",
          "tags: [poem, roleplay]",
          "collection: Conversations with a ghost",
          "part: 3",
          "speakers:",
          "  user: [TB]",
          "  assistant: [Claude-3-Opus]",
        ].join("\n"),
        "TB\nTell me about the keeper.\n\nClaude-3-Opus\nHe kept the light for forty years.\n",
      ),
    );
    expect(fragment.turns).toEqual([
      { role: "user", text: "Tell me about the keeper." },
      { role: "assistant", text: "He kept the light for forty years." },
    ]);
    expect(fragment.seams).toEqual(["TB\n", "\n\nClaude-3-Opus\n"]);
    expect(fragment.tail).toBe("\n");
    expect(fragment.fields).toMatchObject({
      title: "The lighthouse keeper",
      models: ["claude-3-opus"],
      platform: "poe",
      tags: ["poem", "roleplay"],
      collection: "Conversations with a ghost",
      part: "3",
    });
    expect(fragment.warnings).toEqual([]);
  });

  it("keeps the frontmatter as text, YAML comments and unknown keys included", () => {
    const frontmatter = `id: ${ID_A}\n# a guess, not a fact\ncolour: green\ndate: 2024 # about`;
    const fragment = parseOk(fragmentFile(frontmatter, "words\n"));
    expect(fragment.frontmatter).toBe(frontmatter);
    expect(fragment.warnings).toEqual([]);
  });

  it("reads a model as a name or a list, a part as text or a number, a tag as a word or a list", () => {
    expect(parseOk(withId("model: [a, b, a]", "x")).fields.models).toEqual(["a", "b"]);
    expect(parseOk(withId("model: solo", "x")).fields.models).toEqual(["solo"]);
    expect(parseOk(withId("part: 3", "x")).fields.part).toBe("3");
    expect(parseOk(withId("part: 1-a", "x")).fields.part).toBe("1-a");
    expect(parseOk(withId("tags: poem", "x")).fields.tags).toEqual(["poem"]);
  });

  it("warns of a field of the wrong kind and reads the rest", () => {
    const fragment = parseOk(withId("title: [a]\ngenerate: maybe\nmodel: unknown", "x"));
    expect(codes(fragment.warnings).sort()).toEqual(["bad-field", "bad-field", "model-unknown"]);
    expect(fragment.fields.title).toBe("");
    expect(fragment.fields.generate).toBeUndefined();
    expect(fragment.fields.models).toEqual(["unknown"]);
  });

  it("warns that a file which will never be named has no title and no generation", () => {
    expect(codes(parseOk(withId("generate: false", "x")).warnings)).toEqual([
      "no-title-no-generate",
    ]);
    expect(parseOk(withId("generate: false\ntitle: Named", "x")).warnings).toEqual([]);
  });
});

describe("speakers: the whole body is one block when nothing is marked", () => {
  it("is one block, with the blank lines around it in the seams", () => {
    const fragment = parseOk(withId("", "\n\nA poem\nof two lines\n\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "A poem\nof two lines" }]);
    expect(fragment.seams).toEqual(["\n\n"]);
    expect(fragment.tail).toBe("\n\n");
  });

  it("does not guess from a name that looks like a label", () => {
    expect(turnsOf("", "User\nhello\nAssistant\nhi\n")).toEqual([
      [null, "User\nhello\nAssistant\nhi"],
    ]);
  });
});

describe("speakers: HAEVN's own marker", () => {
  it("splits at each marker and puts a system turn apart", () => {
    const body =
      '<!-- HAEVN: role="system" -->\nBe brief.\n\n<!-- HAEVN: role="user" -->\nHi\n\n<!-- HAEVN: role="assistant" -->\nHello\n';
    expect(turnsOf("", body)).toEqual([
      ["system", "Be brief."],
      ["user", "Hi"],
      ["assistant", "Hello"],
    ]);
  });

  it("keeps a --- line inside a turn as written", () => {
    const body =
      '<!-- HAEVN: role="user" -->\nbefore\n---\nafter\n<!-- HAEVN: role="assistant" -->\nok\n';
    expect(turnsOf("", body)[0]).toEqual(["user", "before\n---\nafter"]);
  });

  it("reads single quotes and any case, and only on a line of its own", () => {
    const body =
      "<!--  HAEVN: role='USER' -->\nhi\nnot a marker <!-- HAEVN: role=\"assistant\" --> here\n";
    expect(turnsOf("", body)).toEqual([
      ["user", 'hi\nnot a marker <!-- HAEVN: role="assistant" --> here'],
    ]);
  });

  it("does not read a role it does not know", () => {
    expect(turnsOf("", '<!-- HAEVN: role="tool" -->\nout\n')).toEqual([
      [null, '<!-- HAEVN: role="tool" -->\nout'],
    ]);
  });
});

describe("speakers: a heading typed by hand", () => {
  it("reads ## User, ## Assistant and ## System, in any case and with one to three #", () => {
    const body = "# System\nBe brief.\n\n## user\nHi\n\n### ASSISTANT\nHello\n";
    expect(turnsOf("", body)).toEqual([
      ["system", "Be brief."],
      ["user", "Hi"],
      ["assistant", "Hello"],
    ]);
  });

  it("reads a heading that is exactly a role, and no other", () => {
    expect(turnsOf("", "## User notes\nthe heading is longer\n#### User\ntoo deep\n")).toEqual([
      [null, "## User notes\nthe heading is longer\n#### User\ntoo deep"],
    ]);
  });

  it("is overruled by HAEVN's marker, which comes first", () => {
    const body = '## User\nignored as a mark\n<!-- HAEVN: role="assistant" -->\nreply\n';
    expect(turnsOf("", body)).toEqual([
      [null, "## User\nignored as a mark"],
      ["assistant", "reply"],
    ]);
  });
});

describe("speakers: declared in the frontmatter", () => {
  const both = "speakers:\n  user: [TB]\n  assistant: [Bot]";

  it("reads a label alone, with a colon, and with its text on the same line", () => {
    const body = "TB\nfirst\nBot:\nsecond\nTB: third\nBot: fourth\nand fifth\n";
    expect(turnsOf(both, body)).toEqual([
      ["user", "first"],
      ["assistant", "second"],
      ["user", "third"],
      ["assistant", "fourth\nand fifth"],
    ]);
  });

  it("reads a label that is a string as a list of one", () => {
    expect(turnsOf("speakers:\n  user: TB\n  assistant: Bot", "TB\nhi\nBot\nhello\n")).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });

  it("does not split at a label that is part of a sentence, or in another case", () => {
    const body = "TB\nTB said hello, and Bot: nothing\nbot\nlower case is another word\n";
    expect(turnsOf(both, body)).toEqual([
      ["user", "TB said hello, and Bot: nothing\nbot\nlower case is another word"],
    ]);
  });

  it("makes the text before the first mark a block of its own, and drops it when it is white space", () => {
    expect(turnsOf(both, "a preface\n\nTB\nhi\nBot\nhello\n")).toEqual([
      [null, "a preface"],
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
    expect(turnsOf(both, "\n \nTB\nhi\nBot\nhello\n")).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
    ]);
  });

  it("drops a turn with nothing in it and keeps its marker in the seam", () => {
    const fragment = parseOk(withId(both, "TB\nBot\nhello\n"));
    expect(fragment.turns).toEqual([{ role: "assistant", text: "hello" }]);
    expect(fragment.seams).toEqual(["TB\nBot\n"]);
  });

  it("keeps two turns of one speaker in a row as two turns", () => {
    expect(turnsOf(both, "TB\none\nTB\ntwo\n")).toEqual([
      ["user", "one"],
      ["user", "two"],
    ]);
  });

  it("reads a system label", () => {
    expect(turnsOf("speakers:\n  system: [SYS]\n  user: [Q]", "SYS\nrules\nQ\nask\n")).toEqual([
      ["system", "rules"],
      ["user", "ask"],
    ]);
  });
});

describe("speakers: a prompt prefix", () => {
  const prompt = 'speakers:\n  prompt: ">"';

  it("is the person's turn, and what follows up to the next prompt is the reply", () => {
    const body =
      "> first question\nthe answer\nover two lines\n\n> second question\nanother answer\n";
    const fragment = parseOk(withId(prompt, body));
    expect(fragment.turns).toEqual([
      { role: "user", text: "first question" },
      { role: "assistant", text: "the answer\nover two lines" },
      { role: "user", text: "second question" },
      { role: "assistant", text: "another answer" },
    ]);
    // the prefix and the spaces after it are in the seam
    expect(fragment.seams[0]).toBe("> ");
  });

  it("makes two prompts in a row two turns, and a prompt with no reply a turn with none", () => {
    expect(turnsOf(prompt, "> one\n> two\n")).toEqual([
      ["user", "one"],
      ["user", "two"],
    ]);
  });

  it("takes a list of prefixes, the longest first, and none with a leading space", () => {
    const body = "$ ls\nfiles\n $ not a prompt\n>> deeper\n";
    expect(turnsOf('speakers:\n  prompt: ["$", ">", ">>"]', body)).toEqual([
      ["user", "ls"],
      ["assistant", "files\n $ not a prompt"],
      ["user", "deeper"],
    ]);
  });

  it("is no turn when the prefix has nothing after it, and the reply under it still is", () => {
    expect(turnsOf('speakers:\n  prompt: "$"', "$\noutput\n")).toEqual([["assistant", "output"]]);
  });

  it("works beside labels", () => {
    const body = "Bot\nintro\n> ask\nanswer\n";
    expect(turnsOf('speakers:\n  assistant: [Bot]\n  prompt: ">"', body)).toEqual([
      ["assistant", "intro"],
      ["user", "ask"],
      ["assistant", "answer"],
    ]);
  });
});

describe("speakers: break", () => {
  const brk = "speakers:\n  break: [Copy]";

  it("starts a block at each matching line, and the line goes to the seam", () => {
    const fragment = parseOk(withId(brk, "Copy\nfirst\nmore\n\nCopy\nsecond\n"));
    expect(fragment.turns).toEqual([
      { role: null, text: "first\nmore" },
      { role: null, text: "second" },
    ]);
    expect(fragment.seams).toEqual(["Copy\n", "\n\nCopy\n"]);
    expect(fragment.warnings).toEqual([]);
  });

  it("matches as the other labels do: trimmed, with a colon, with text after a colon, exact", () => {
    const body = "  Copy  \na\nCopy:\nb\nCopy: c\nd\nCopy said so\ncopy\n";
    expect(turnsOf(brk, body)).toEqual([
      [null, "a"],
      [null, "b"],
      [null, "c\nd\nCopy said so\ncopy"],
    ]);
  });

  it("reads a string as a list of one, and a list as several labels", () => {
    expect(turnsOf("speakers:\n  break: Copy", "Copy\na\nCopy\nb\n")).toHaveLength(2);
    expect(turnsOf("speakers:\n  break: [Copy, Page]", "Copy\na\nPage\nb\nCopy\nc\n")).toEqual([
      [null, "a"],
      [null, "b"],
      [null, "c"],
    ]);
  });

  it("works beside a speaker: the block is nobody's, the turn is the speaker's", () => {
    const extra = "speakers:\n  user: [TB]\n  break: [Copy]";
    expect(turnsOf(extra, "TB\nask\nCopy\nreply\nTB\nagain\nCopy\nreply two\n")).toEqual([
      ["user", "ask"],
      [null, "reply"],
      ["user", "again"],
      [null, "reply two"],
    ]);
  });

  it("is one-sided to no one: a file with a break does not get the one-side warning", () => {
    const fragment = parseOk(
      withId("speakers:\n  user: [TB]\n  break: [Copy]", "TB\na\nCopy\nb\nTB\nc\nCopy\nd\n"),
    );
    expect(fragment.warnings).toEqual([]);
  });

  it("drops a block with nothing in it and keeps its marker in the seam", () => {
    const fragment = parseOk(withId(brk, "Copy\nCopy\nonly\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "only" }]);
    expect(fragment.seams).toEqual(["Copy\nCopy\n"]);
  });

  it("warns that nothing matched when no line is a break, and the file is one block", () => {
    const fragment = parseOk(withId(brk, "no mark here\n"));
    expect(codes(fragment.warnings)).toEqual(["speakers-no-match"]);
    expect(fragment.turns).toEqual([{ role: null, text: "no mark here" }]);
  });

  it("is overruled, as every declaration is, by marks the body has of its own", () => {
    const fragment = parseOk(withId(brk, "## User\nhi\nCopy\nstill the user\n"));
    expect(codes(fragment.warnings)).toEqual(["speakers-unused"]);
    expect(fragment.turns).toEqual([{ role: "user", text: "hi\nCopy\nstill the user" }]);
  });
});

describe("speakers: the text before the first mark, and lead", () => {
  const both = "speakers:\n  user: [TB]\n  assistant: [Bot]";

  it("is a block of its own beside break, never folded into the seam", () => {
    const fragment = parseOk(withId("speakers:\n  break: [Copy]", "a preface\n\nCopy\nfirst\n"));
    expect(fragment.turns).toEqual([
      { role: null, text: "a preface" },
      { role: null, text: "first" },
    ]);
    expect(fragment.seams).toEqual(["", "\n\nCopy\n"]);
  });

  it("is nothing when it is white space only", () => {
    const fragment = parseOk(
      withId("speakers:\n  break: [Copy]\n  lead: user", "\n \t\nCopy\nfirst\n"),
    );
    expect(fragment.turns).toEqual([{ role: null, text: "first" }]);
  });

  it("is the speaker lead names", () => {
    for (const lead of ["user", "assistant", "system"] as const) {
      const fragment = parseOk(withId(`${both}\n  lead: ${lead}`, "opening\nTB\nhi\nBot\nho\n"));
      expect(fragment.turns.map((turn) => [turn.role, turn.text])).toEqual([
        [lead, "opening"],
        ["user", "hi"],
        ["assistant", "ho"],
      ]);
      expect(fragment.warnings).toEqual([]);
    }
  });

  it("reads lead in any case, and a lead beside break names the first block only", () => {
    const fragment = parseOk(
      withId("speakers:\n  break: [Copy]\n  lead: User", "ask\nCopy\nreply\nCopy\nmore\n"),
    );
    expect(fragment.turns.map((turn) => turn.role)).toEqual(["user", null, null]);
  });

  it("does not make a body that is only a system prompt a chat of nothing else: one block, and a word", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]\n  lead: system", "just text\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "just text" }]);
    expect(codes(fragment.warnings)).toEqual(["speakers-no-match"]);
  });

  it("is not applied when the marks have nothing after them", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]\n  lead: system", "text\nTB\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "text\nTB" }]);
  });

  it("is applied when the body marks its own turns, headings and HAEVN markers alike, with no warning", () => {
    for (const body of [
      "preface\n## User\nhi\n## Assistant\nho\n",
      'preface\n<!-- HAEVN: role="user" -->\nhi\n<!-- HAEVN: role="assistant" -->\nho\n',
    ]) {
      const fragment = parseOk(withId("speakers:\n  lead: system", body));
      expect(fragment.turns.map((turn) => [turn.role, turn.text])).toEqual([
        ["system", "preface"],
        ["user", "hi"],
        ["assistant", "ho"],
      ]);
      expect(fragment.warnings).toEqual([]);
    }
  });

  it("is still not a label: labels beside the body's own marks are unused, with a word, and lead is not", () => {
    const fragment = parseOk(
      withId("speakers:\n  user: [TB]\n  lead: assistant", "preface\n## User\nhi\n"),
    );
    expect(codes(fragment.warnings)).toEqual(["speakers-unused"]);
    expect(fragment.turns.map((turn) => turn.role)).toEqual(["assistant", "user"]);
  });

  it("names the whole body when no mark was found and it is the user's or the assistant's", () => {
    for (const lead of ["user", "assistant"] as const) {
      const fragment = parseOk(withId(`speakers:\n  lead: ${lead}`, "all of it\n\nand more\n"));
      expect(fragment.turns).toEqual([{ role: lead, text: "all of it\n\nand more" }]);
      expect(fragment.warnings).toEqual([]);
    }
  });

  it("says, for a lead that is system and nothing else, that the file is one block, and names lead", () => {
    const fragment = parseOk(withId("speakers:\n  lead: system", "only rules\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "only rules" }]);
    expect(fragment.warnings).toEqual([
      expect.objectContaining({
        code: "speakers-no-match",
        message: expect.stringContaining("speakers.lead"),
      }),
    ]);
  });

  it("says it once when labels matched nothing as well", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]\n  lead: system", "rules\n"));
    expect(codes(fragment.warnings)).toEqual(["speakers-no-match"]);
  });

  it("is not a turn a label found: it does not make a one-sided file two-sided", () => {
    const fragment = parseOk(
      withId("speakers:\n  user: [TB]\n  lead: assistant", "hello\nTB\none\nTB\ntwo\n"),
    );
    expect(codes(fragment.warnings)).toEqual(["speakers-one-side"]);
  });
});

describe("the parser version a file needs", () => {
  const needs = (extra: string, body: string) => parseOk(withId(extra, body)).minVersion;

  it("is 2 for a file that declares break or lead, and 1 for any other", () => {
    expect(needs("speakers:\n  break: [Copy]", "Copy\nhi\n")).toBe(2);
    expect(needs("speakers:\n  lead: user", "hi\n")).toBe(2);
    expect(needs("speakers:\n  lead: system", "hi\n")).toBe(2);
    expect(needs("", "plain\n")).toBe(1);
    expect(needs("speakers:\n  user: [TB]\n  prompt: '>'", "TB\nhi\n")).toBe(1);
    expect(needs("speakers:\n  user: [TB]", "## User\nhi\n")).toBe(1);
  });

  it("does not count a break the body's own marks leave unread, or a lead that is not read", () => {
    expect(needs("speakers:\n  break: [Copy]", "## User\nhi\n")).toBe(1);
    expect(needs("speakers:\n  lead: narrator", "hi\n")).toBe(1);
    expect(needs("speakers:\n  break: []", "hi\n")).toBe(1);
  });

  it("is 2 for a break that matched nothing, as for one that matched", () => {
    expect(needs("speakers:\n  break: [Copy]", "no mark here\n")).toBe(2);
  });
});

describe("speakers: what it warns of and never refuses", () => {
  it("names an unknown key, and keeps it whole in the fields", () => {
    const fragment = parseOk(
      withId("speakers:\n  asistant: [Bot]\n  user: [TB]", "TB\nhi\nBot\nyo\n"),
    );
    expect(fragment.warnings).toEqual([
      { code: "speakers-unknown-key", message: "speakers.asistant is not read" },
    ]);
    expect(fragment.fields.speakers).toEqual({ asistant: ["Bot"], user: ["TB"] });
  });

  it("warns of a key of the wrong type, and of speakers that is not a map", () => {
    expect(codes(parseOk(withId("speakers:\n  user: {a: 1}", "x")).warnings)).toEqual([
      "speakers-bad-type",
    ]);
    expect(codes(parseOk(withId("speakers: [a, b]", "x")).warnings)).toEqual(["speakers-bad-type"]);
  });

  it("warns of a label under two keys and uses the first", () => {
    const fragment = parseOk(withId("speakers:\n  user: [X]\n  assistant: [X]", "X\nhi\n"));
    expect(codes(fragment.warnings)).toContain("speakers-duplicate-label");
    expect(fragment.turns[0].role).toBe("user");
  });

  it("warns of a label under break and a speaker, and the speaker has it", () => {
    for (const speaker of ["user", "assistant", "system"] as const) {
      const declared = speaker === "user" ? "user: [X, TB]" : `${speaker}: [X]\n  user: [TB]`;
      const fragment = parseOk(withId(`speakers:\n  break: [X]\n  ${declared}`, "TB\nhi\nX\nho\n"));
      expect(fragment.warnings).toContainEqual({
        code: "speakers-duplicate-label",
        message: expect.stringContaining(`${speaker} is used`),
      });
      expect(fragment.turns.map((turn) => turn.role)).toEqual(["user", speaker]);
    }
  });

  it("warns of break and lead of the wrong type, and reads neither", () => {
    const badBreak = parseOk(withId("speakers:\n  break: {a: 1}", "Copy\nhi\n"));
    expect(badBreak.warnings).toEqual([
      expect.objectContaining({
        code: "speakers-bad-type",
        message: expect.stringContaining("break"),
      }),
    ]);
    expect(badBreak.turns).toHaveLength(1);

    for (const lead of ["narrator", "[user]", "3"]) {
      const fragment = parseOk(
        withId(`speakers:\n  user: [Q]\n  lead: ${lead}`, "preface\nQ\nhi\n"),
      );
      expect(fragment.warnings).toEqual([
        {
          code: "speakers-bad-type",
          message: "speakers.lead must be user, assistant or system",
        },
      ]);
      expect(fragment.turns.map((turn) => turn.role)).toEqual([null, "user"]);
    }
  });

  it("warns that a declaration matched no line, and the file is one block", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]", "no label here\n"));
    expect(codes(fragment.warnings)).toEqual(["speakers-no-match"]);
    expect(fragment.turns).toEqual([{ role: null, text: "no label here" }]);
  });

  it("warns when every turn belongs to the one side that is declared", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]", "TB\none\nTB\ntwo\nTB\nthree\n"));
    expect(fragment.warnings).toEqual([
      expect.objectContaining({
        code: "speakers-one-side",
        message:
          "3 turns, all the user's: if this label only marks where an exchange starts, declare it under `break`",
      }),
    ]);
    expect(fragment.turns).toHaveLength(3);
  });

  it("does not call a prompt file one-sided", () => {
    expect(parseOk(withId('speakers:\n  prompt: ">"', "> a\nb\n> c\nd\n")).warnings).toEqual([]);
  });

  it("says that speakers is not used when the body marks its own", () => {
    const fragment = parseOk(withId("speakers:\n  user: [TB]", "## User\nhi\n"));
    expect(codes(fragment.warnings)).toEqual(["speakers-unused"]);
    expect(fragment.turns).toEqual([{ role: "user", text: "hi" }]);
  });

  it("falls back to one block when the marks have nothing after them", () => {
    const fragment = parseOk(withId("", "## User\n\n## Assistant\n"));
    expect(fragment.turns).toEqual([{ role: null, text: "## User\n\n## Assistant" }]);
  });
});

describe("kept as written: the seams and the turns put the body back", () => {
  const bodies: Array<[string, string, string]> = [
    ["one block", "", "plain\n"],
    ["no final newline", "", "plain"],
    ["blank lines around", "", "\n\n  indented\n\n\n"],
    ["CRLF", "speakers:\n  user: [TB]\n  assistant: [Bot]", "TB\r\nhi\r\n\r\nBot\r\nho\r\n"],
    ["mixed endings", "speakers:\n  user: [TB]", "TB\nhi\r\nthere\n"],
    ["a --- rule", "", "one\n---\ntwo\n"],
    ["a body that starts with ---", "", "---\nnot frontmatter\n"],
    [
      "HAEVN markers and a system turn",
      "",
      '<!-- HAEVN: role="system" -->\ns\n<!-- HAEVN: role="user" -->\nu\n<!-- HAEVN: role="assistant" -->\na\n',
    ],
    ["headings with empty turns", "", "## User\n## Assistant\nreply\n## User\n\n"],
    [
      "labels with inline text",
      "speakers:\n  user: [Q]\n  assistant: [A]",
      "Q: why\nA: because\nQ:   spaced\n",
    ],
    ["prompts", 'speakers:\n  prompt: ["$", ">"]', "$ one\n\nout\n> two\n$ three\n\n\nout\n"],
    ["text before the first mark", "speakers:\n  user: [Q]", "preface\n\nQ\nhi\n"],
    ["unicode and tabs", "speakers:\n  user: [Q]", "Q\n\tcafé — 日本語 ☃\n"],
    ["a turn that is one character", "speakers:\n  user: [Q]\n  assistant: [A]", "Q\nx\nA\ny"],
    [
      "breaks",
      "speakers:\n  break: [Copy]",
      "Copy\nfirst\n\nmore\n\n\nCopy\nsecond\nCopy\n\nCopy\nlast",
    ],
    ["breaks with CRLF", "speakers:\n  break: [Copy]", "Copy\r\none\r\n\r\nCopy\r\ntwo\r\n"],
    ["breaks with inline text", "speakers:\n  break: [Copy]", "Copy: one\ntwo\nCopy:   three\n"],
    [
      "a break and a lead",
      "speakers:\n  break: [Copy]\n  lead: user",
      "\n  asked first\n\nCopy\nanswer one\n\n\nCopy\nanswer two\n\n",
    ],
    [
      "a lead that is a system prompt, a speaker and a break",
      "speakers:\n  lead: system\n  user: [TB]\n  break: [Copy]",
      "rules\nof the house\nTB\nhi\nCopy\nho\nTB\nagain\n",
    ],
    [
      "only a lead block with a mark that has no text",
      "speakers:\n  user: [TB]\n  lead: user",
      "x\nTB\n",
    ],
  ];

  it.each(bodies)("%s", async (_label, extra, body) => {
    const fragment = await parsed(withId(extra, body));
    const chat = transformFragmentToHaevnChat(fragment, 1);
    expect(reassembleFragment(chat)).toBe(body);
  });

  it("holds after the chat has been through JSON, as a backup and a restore leave it", async () => {
    const body = '<!-- HAEVN: role="system" -->\ns\n\n<!-- HAEVN: role="user" -->\nu\n';
    const chat = transformFragmentToHaevnChat(await parsed(withId("", body)), 1);
    expect(reassembleFragment(JSON.parse(JSON.stringify(chat)))).toBe(body);
  });

  it("holds for twelve turns in file order, whatever order the messages are stored in", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `## User\nturn ${i + 1}\n`).join("\n");
    const chat = transformFragmentToHaevnChat(await parsed(withId("", body)), 1);
    const shuffled = {
      ...chat,
      messages: Object.fromEntries(Object.entries(chat.messages).reverse()),
    };
    expect(reassembleFragment(shuffled)).toBe(body);
  });
});
