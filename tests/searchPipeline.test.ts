import lunr from "lunr";
import { describe, expect, it, vi } from "vitest";
import { createIndexBuilder, wordTrimmer } from "../src/services/searchPipeline";
import { wordBounds } from "../src/services/searchSnippet";

function trimmed(word: string): string {
  return wordTrimmer(new lunr.Token(word, {}), 0, []).toString();
}

describe("wordTrimmer (HVN-65)", () => {
  it("takes the punctuation off both ends of an ASCII word", () => {
    expect(trimmed("wombatz,")).toBe("wombatz");
    expect(trimmed("(wombatz)")).toBe("wombatz");
    expect(trimmed("wombatz!")).toBe("wombatz");
    expect(trimmed("`code`")).toBe("code");
    expect(trimmed("don't")).toBe("don't");
    expect(trimmed("v2_beta.")).toBe("v2_beta");
  });

  it("keeps words in other scripts, which lunr's own trimmer erases", () => {
    const words: [string, string][] = [
      ["привет,", "привет"],
      ["«мир»", "мир"],
      ["καλημέρα!", "καλημέρα"],
      ["你好世界。", "你好世界"],
      ["café,", "café"],
      // a word may end in a combining mark (Devanagari "ी", a decomposed "é")
      ["हिन्दी,", "हिन्दी"],
      ["café;", "café"],
    ];
    for (const [word, expected] of words) {
      expect(trimmed(word)).toBe(expected);
      expect(lunr.trimmer(new lunr.Token(word, {})).toString()).not.toBe(expected);
    }
  });

  it("leaves a symbol or a run of punctuation a term of its own", () => {
    expect(trimmed("😀,")).toBe("😀");
    expect(trimmed("!!!")).toBe("!!!");
    expect(trimmed("++")).toBe("++");
  });

  it("trims the way the snippet marks do", () => {
    for (const word of ["wombatz,", "(привет)", "你好。", "😀,", "!!!", "हिन्दी,"]) {
      const { start, end } = wordBounds(word);
      expect(trimmed(word)).toBe(word.slice(start, end));
    }
  });
});

describe("createIndexBuilder (HVN-65)", () => {
  const text = "one wombatz two wombatz, three wombatz. four wombatz; five (wombatz) six wombatz!";

  function build(doc: { id: string; title: string; content: string }) {
    const builder = createIndexBuilder();
    builder.add(doc);
    return builder.build();
  }

  it("indexes every spelling of a word under the word", () => {
    const index = build({ id: "a", title: "t", content: text });

    const [hit] = index.search("wombatz");

    expect(hit.ref).toBe("a");
    const positions = (
      hit.matchData.metadata as Record<string, Record<string, { position: unknown[] }>>
    ).wombatz.content.position;
    expect(positions).toHaveLength(6);
  });

  it("trims the query too, so a term typed with its punctuation finds the word", () => {
    const index = build({ id: "a", title: "t", content: text });

    expect(index.search("wombatz,").map((r) => r.ref)).toEqual(["a"]);
    expect(index.search("(wombatz)").map((r) => r.ref)).toEqual(["a"]);
  });

  it("finds words in other scripts", () => {
    const index = build({
      id: "a",
      title: "t",
      content: "привет, мир! καλημέρα κόσμε; 你好世界。 😀, हिन्दी,",
    });

    for (const query of ["привет", "мир", "καλημέρα", "κόσμε", "你好世界", "😀", "हिन्दी"]) {
      expect(
        index.search(query).map((r) => r.ref),
        query,
      ).toEqual(["a"]);
    }
  });

  it("keeps the trimmer when the index is stored and loaded", () => {
    const stored = JSON.parse(
      JSON.stringify(build({ id: "a", title: "t", content: "a wombatz, b" })),
    );

    const loaded = lunr.Index.load(stored);

    expect(loaded.search("wombatz,").map((r) => r.ref)).toEqual(["a"]);
  });

  it("weights a title match above a content match", () => {
    const builder = createIndexBuilder();
    builder.add({ id: "body", title: "other", content: "pineapple" });
    builder.add({ id: "title", title: "pineapple", content: "other" });

    expect(builder.build().search("pineapple")[0].ref).toBe("title");
  });
});

describe("the trimmer's registration", () => {
  it("does not warn or throw when the module is loaded a second time", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.resetModules();
      const again = await import("../src/services/searchPipeline");
      expect(typeof again.wordTrimmer).toBe("function");
      expect(() => again.createIndexBuilder()).not.toThrow();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
