import { describe, expect, it } from "vitest";
import { isStopWord } from "../src/services/searchStopWords";

describe("isStopWord", () => {
  it("knows the English words that say nothing (the caller has lower-cased the term)", () => {
    for (const word of ["the", "how", "should", "would", "your"]) {
      expect(isStopWord(word)).toBe(true);
    }
  });

  it("does not take a word that says something, or a word of another language", () => {
    for (const word of ["pineapple", "react", "der", "und", "日本語"]) {
      expect(isStopWord(word)).toBe(false);
    }
  });
});
