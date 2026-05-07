import { describe, expect, it } from "vitest";
import { normalizeSearchText, parseSearchQuery } from "../src/services/searchQuery";
import {
  buildLunrQueryPlan,
  buildRelaxedPrefixQuery,
  queryNeedsExactPhrasePath,
} from "../src/services/searchWorkerQuery";

describe("search query normalization", () => {
  it("parses phrases and terms case-insensitively", () => {
    expect(parseSearchQuery('"Dear Eliezer" FOO foo')).toEqual({
      phrases: ["dear eliezer"],
      terms: ["foo"],
    });
  });

  it("marks stopword-bearing phrases for exact text verification", () => {
    expect(buildLunrQueryPlan('"Dear Eliezer"')).toEqual({
      finalQuery: "+eliezer",
      hasPhrases: true,
      phraseConstraints: [
        {
          normalizedPhrase: "dear eliezer",
          terms: ["dear", "eliezer"],
          requiresTextVerification: true,
        },
      ],
    });
  });

  it("keeps non-stopword phrases on the fast metadata path", () => {
    expect(buildLunrQueryPlan('"eliezer yudkowsky"')).toEqual({
      finalQuery: "+eliezer +yudkowsky",
      hasPhrases: true,
      phraseConstraints: [
        {
          normalizedPhrase: "eliezer yudkowsky",
          terms: ["eliezer", "yudkowsky"],
          requiresTextVerification: false,
        },
      ],
    });
    expect(queryNeedsExactPhrasePath('"eliezer yudkowsky"')).toBe(false);
    expect(queryNeedsExactPhrasePath('"dear eliezer"')).toBe(true);
  });

  it("normalizes implicit AND queries to lowercase and skips stop words when possible", () => {
    expect(buildLunrQueryPlan("Dear Eliezer")).toEqual({
      finalQuery: "+eliezer",
      hasPhrases: false,
      phraseConstraints: [],
    });
  });

  it("builds relaxed prefix queries in lowercase", () => {
    expect(buildRelaxedPrefixQuery("FISH Hello")).toBe("fish* hello*");
  });

  it("normalizes searchable text for exact phrase verification", () => {
    expect(normalizeSearchText("Dear   Gemini,\nThis is a test")).toBe("dear gemini, this is a test");
  });
});
