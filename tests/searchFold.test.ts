import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldText, foldWithMap } from "../src/services/searchFold";
import { openSqliteHost, resetMemorySqliteHost, TOKENIZER } from "../src/services/searchIndex";

describe("searchFold: the JavaScript fold is the index's (HVN-87)", () => {
  // One document per character, "a" + char + "b", in a table with the index's tokenizer. A
  // document is found by `foldText` of its text exactly when the tokenizer made the same word.
  const blocks: [number, number][] = [
    [0x20, 0x24f], // Basic Latin, Latin-1, Latin Extended-A and B
    [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
    [0x300, 0x36f], // combining marks
    [0x370, 0x3ff], // Greek
    [0x400, 0x527], // Cyrillic and its supplement: й and ё are letters of their own
  ];
  const chars = blocks.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i)),
  );
  const found = new Map<string, boolean>();

  beforeAll(async () => {
    resetMemorySqliteHost();
    const host = await openSqliteHost();
    const db = host.open("/fold-check.db");
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, tokenize = "${TOKENIZER}")`);
    chars.forEach((char, i) => {
      db.exec({ sql: "INSERT INTO t(rowid, body) VALUES (?, ?)", bind: [i + 1, `a${char}b`] });
    });
    chars.forEach((char, i) => {
      const word = foldText(`a${char}b`);
      const rows = db.exec({
        sql: "SELECT rowid FROM t WHERE t MATCH ?",
        bind: [`"${word.replace(/"/g, '""')}"`],
        rowMode: "array",
        returnValue: "resultRows",
      }) as number[][];
      found.set(
        char,
        rows.some((r) => r[0] === i + 1),
      );
    });
  });

  afterAll(() => resetMemorySqliteHost());

  it("makes the word the tokenizer makes, for every letter, mark and digit of those blocks", () => {
    const letters = chars.filter((c) => /[\p{L}\p{M}\p{N}]/u.test(c));
    expect(letters.length).toBeGreaterThan(900);
    const disagreed = letters.filter((c) => !found.get(c));
    // Print the characters, not a count, so that a failure says which.
    expect(disagreed.map((c) => `U+${c.codePointAt(0)?.toString(16)} ${c}`)).toEqual([]);
  });
});

describe("searchFold", () => {
  it("folds the accents of Latin letters and nothing else", () => {
    expect(foldText("Café")).toBe("cafe");
    expect(foldText("İstanbul")).toBe("istanbul");
    expect(foldText("Ёж й")).toBe("ёж й");
    expect(foldText("日本語 😀 हिन्दी")).toBe("日本語 😀 हिन्दी");
  });

  it("drops a combining accent wherever it stands", () => {
    expect(foldText("café")).toBe("cafe");
  });

  it("maps each folded unit back to the characters it came from", () => {
    const text = "x İz y";
    const { folded, starts, ends } = foldWithMap(text);
    const at = folded.indexOf("iz");

    expect(text.slice(starts[at], ends[at + 1])).toBe("İz");
  });
});
