import { describe, expect, it } from "vitest";
import {
  buildSnippet,
  lowerCaseRangeMapper,
  type TextRange,
  trimToWord,
} from "../src/services/searchSnippet";

/** Where each occurrence of `word` starts, as ranges. */
function rangesOf(text: string, word: string): TextRange[] {
  const found: TextRange[] = [];
  for (let i = text.indexOf(word); i !== -1; i = text.indexOf(word, i + 1)) {
    found.push({ start: i, length: word.length });
  }
  return found;
}

const filler = (n: number, seed = "lorem ipsum ") =>
  seed.repeat(Math.ceil(n / seed.length)).slice(0, n);

describe("buildSnippet", () => {
  it("contains a match far past the start of the text, marked, with the cut ends shown", () => {
    const text = `${filler(700)}NEEDLE${filler(700)}`;
    const snippet = buildSnippet(text, rangesOf(text, "NEEDLE"), { radius: 30 });
    expect(snippet).toContain("{{HIGHLIGHT}}NEEDLE{{/HIGHLIGHT}}");
    expect(snippet.startsWith("... ")).toBe(true);
    expect(snippet.endsWith(" ...")).toBe(true);
    expect(snippet.length).toBeLessThan(120);
  });

  it("marks every match inside the window", () => {
    const text = "the cat sat; the cat ran; the dog slept all day long";
    const snippet = buildSnippet(text, rangesOf(text, "cat"), { radius: 20 });
    expect(snippet).toBe(
      "the {{HIGHLIGHT}}cat{{/HIGHLIGHT}} sat; the {{HIGHLIGHT}}cat{{/HIGHLIGHT}} ran; the dog slept ...",
    );
  });

  it("shows up to three windows, in text order, when the matches are far apart", () => {
    const text = [
      "one",
      filler(300),
      "two",
      filler(300),
      "three",
      filler(300),
      "four",
      filler(300),
    ].join(" ");
    const anchors = ["one", "two", "three", "four"].flatMap((w) => rangesOf(text, w));
    const snippet = buildSnippet(text, anchors, { radius: 15 });
    expect(snippet).toContain("{{HIGHLIGHT}}one{{/HIGHLIGHT}}");
    expect(snippet).toContain("{{HIGHLIGHT}}two{{/HIGHLIGHT}}");
    expect(snippet).toContain("{{HIGHLIGHT}}three{{/HIGHLIGHT}}");
    expect(snippet).not.toContain("four");
    expect(snippet.split(" ... ")).toHaveLength(3);
    expect(snippet.indexOf("one")).toBeLessThan(snippet.indexOf("two"));
    expect(snippet.indexOf("two")).toBeLessThan(snippet.indexOf("three"));
  });

  it("always includes the earliest match, whatever follows it", () => {
    const text = `${filler(500)}first${filler(500)}second${filler(500)}`;
    const anchors = [...rangesOf(text, "second"), ...rangesOf(text, "first")]; // unsorted
    const snippet = buildSnippet(text, anchors, { radius: 20, maxWindows: 1 });
    expect(snippet).toContain("{{HIGHLIGHT}}first{{/HIGHLIGHT}}");
    expect(snippet).not.toContain("second");
  });

  it("joins windows that meet into one, with no ellipsis between", () => {
    const text = `${filler(200)} alpha beta ${filler(200)}`;
    const anchors = [...rangesOf(text, "alpha"), ...rangesOf(text, "beta")];
    const snippet = buildSnippet(text, anchors, { radius: 10 });
    expect(snippet).toContain("{{HIGHLIGHT}}alpha{{/HIGHLIGHT}} {{HIGHLIGHT}}beta{{/HIGHLIGHT}}");
    expect(snippet.match(/ \.\.\. /g)).toBeNull();
  });

  it("writes one mark for ranges that overlap", () => {
    const text = "searching the archive";
    const snippet = buildSnippet(
      text,
      [
        { start: 0, length: 6 },
        { start: 3, length: 9 },
      ],
      { radius: 50 },
    );
    expect(snippet).toBe("{{HIGHLIGHT}}searching th{{/HIGHLIGHT}}e archive");
  });

  it("has no ellipsis where the text is not cut: a match at the start, at the end, in a short text", () => {
    const longTail = `start ${filler(300)}`;
    expect(buildSnippet(longTail, rangesOf(longTail, "start"), { radius: 20 })).toBe(
      `{{HIGHLIGHT}}start{{/HIGHLIGHT}} ${filler(300).slice(0, 19).trim()} ...`,
    );

    const longHead = `${filler(300)} end`;
    const tail = buildSnippet(longHead, rangesOf(longHead, "end"), { radius: 20 });
    expect(tail.startsWith("... ")).toBe(true);
    expect(tail.endsWith("{{HIGHLIGHT}}end{{/HIGHLIGHT}}")).toBe(true);

    const short = "a pineapple here";
    expect(buildSnippet(short, rangesOf(short, "pineapple"), { radius: 60 })).toBe(
      "a {{HIGHLIGHT}}pineapple{{/HIGHLIGHT}} here",
    );
  });

  it("marks only what lies inside a window, and clamps a mark at the window's edge", () => {
    const text = `${filler(100)} target ${filler(100)} target`;
    const anchors = [rangesOf(text, "target")[0]];
    const snippet = buildSnippet(text, anchors, {
      radius: 10,
      marks: rangesOf(text, "target"),
    });
    expect(snippet.match(/\{\{HIGHLIGHT\}\}/g)).toHaveLength(1);
  });

  it("counts radius in characters of the text: CJK text keeps the same window", () => {
    const text = `${"字".repeat(50)}搜索${"字".repeat(50)}`;
    const snippet = buildSnippet(text, [{ start: 50, length: 2 }], { radius: 5 });
    expect(snippet).toBe(
      `... ${"字".repeat(5)}{{HIGHLIGHT}}搜索{{/HIGHLIGHT}}${"字".repeat(5)} ...`,
    );
  });

  it("does not cut an astral character in half at the edge of a window", () => {
    // Each emoji is two UTF-16 units; radius 3 would end the window between the halves.
    const text = `${"😀".repeat(10)}hit${"😀".repeat(10)}`;
    const snippet = buildSnippet(text, [{ start: 20, length: 3 }], { radius: 3 });
    expect(snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(snippet).not.toMatch(/(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(snippet).toContain("{{HIGHLIGHT}}hit{{/HIGHLIGHT}}");
  });

  it("collapses whitespace runs and newlines into single spaces", () => {
    const text = "line one\n\nline   two with the match\n  line three";
    const snippet = buildSnippet(text, rangesOf(text, "match"), { radius: 100 });
    expect(snippet).toBe("line one line two with the {{HIGHLIGHT}}match{{/HIGHLIGHT}} line three");
  });

  it("falls back to the start of the text when no range is usable", () => {
    const text = filler(400);
    const snippet = buildSnippet(
      text,
      [
        { start: -5, length: 3 },
        { start: 9999, length: 3 },
        { start: 4, length: 0 },
      ],
      { radius: 20 },
    );
    expect(snippet).not.toContain("{{HIGHLIGHT}}");
    expect(snippet.startsWith("lorem ipsum")).toBe(true);
    expect(snippet.endsWith(" ...")).toBe(true);
  });

  it("returns an empty string for empty text", () => {
    expect(buildSnippet("", [{ start: 0, length: 1 }], { radius: 10 })).toBe("");
  });
});

describe("trimToWord", () => {
  const trimmed = (text: string, start: number, length: number) => {
    const r = trimToWord(text, { start, length });
    return text.slice(r.start, r.start + r.length);
  };

  it("takes the punctuation lunr counts into the token off both ends", () => {
    expect(trimmed("say (pineapple), please", 4, 12)).toBe("pineapple");
    expect(trimmed("pineapple.", 0, 10)).toBe("pineapple");
  });

  it("keeps letters and digits of any script", () => {
    expect(trimmed("«搜索»", 0, 4)).toBe("搜索");
    expect(trimmed("v2_beta!", 0, 8)).toBe("v2_beta");
  });

  it("keeps a combining mark that ends the word", () => {
    expect(trimmed("हिन्दी, ठीक", 0, 7)).toBe("हिन्दी");
    expect(trimmed("cafe\u0301;", 0, 6)).toBe("cafe\u0301");
  });

  it("keeps a symbol that is the word, and takes the punctuation off it", () => {
    expect(trimmed("great 😀, thanks", 6, 4)).toBe("😀");
  });

  it("marks every spelling of a word in a sentence", () => {
    const text =
      "one wombatz two wombatz, three wombatz. four wombatz; five (wombatz) six wombatz!";
    const tokens = [...text.matchAll(/\S+/g)].filter((m) => m[0].includes("wombatz"));
    const anchors = tokens.map((m) =>
      trimToWord(text, { start: m.index ?? 0, length: m[0].length }),
    );

    const snippet = buildSnippet(text, anchors, { radius: 200 });

    expect(snippet.split("{{HIGHLIGHT}}wombatz{{/HIGHLIGHT}}")).toHaveLength(7);
  });

  it("leaves a range of nothing but punctuation as it was", () => {
    expect(trimToWord("a ++ b", { start: 2, length: 2 })).toEqual({ start: 2, length: 2 });
  });
});

describe("lowerCaseRangeMapper (HVN-57)", () => {
  // What lunr reports for a word: its place in the lower-cased text, where "İ" is two units.
  const lowerRangeOf = (text: string, word: string): TextRange => ({
    start: text.toLowerCase().indexOf(word),
    length: word.length,
  });

  it("needs no mapping for text whose lower case is as long", () => {
    expect(lowerCaseRangeMapper("Hello WORLD, ÄÖ 字 😀")).toBeNull();
  });

  it("moves a range back over every İ before it", () => {
    const text = `${"İ".repeat(80)} pineapple`;
    const map = lowerCaseRangeMapper(text);

    expect(lowerRangeOf(text, "pineapple").start).toBe(161);
    expect(map?.(lowerRangeOf(text, "pineapple"))).toEqual({ start: 81, length: 9 });
  });

  it("takes the whole of an İ that the range starts or ends inside", () => {
    const map = lowerCaseRangeMapper("aİb");

    // lower case: "a", "i", U+0307, "b"
    expect(map?.({ start: 1, length: 1 })).toEqual({ start: 1, length: 1 });
    expect(map?.({ start: 2, length: 1 })).toEqual({ start: 1, length: 1 });
    expect(map?.({ start: 1, length: 3 })).toEqual({ start: 1, length: 2 });
    expect(map?.({ start: 3, length: 1 })).toEqual({ start: 2, length: 1 });
  });

  it("counts a character outside the BMP as the two units it is", () => {
    const text = "😀 İ 😀 pineapple";
    const map = lowerCaseRangeMapper(text);

    const mapped = map?.(lowerRangeOf(text, "pineapple")) ?? { start: -1, length: 0 };
    expect(text.slice(mapped.start, mapped.start + mapped.length)).toBe("pineapple");
  });

  it("marks the word in a snippet of text with an İ before it", () => {
    const text = `İstanbul İzmir ${filler(40)} pineapple ${filler(40)}`;
    const map = lowerCaseRangeMapper(text);
    const range = map?.(lowerRangeOf(text, "pineapple"));

    expect(buildSnippet(text, range ? [range] : [], { radius: 10 })).toContain(
      "{{HIGHLIGHT}}pineapple{{/HIGHLIGHT}}",
    );
  });
});
