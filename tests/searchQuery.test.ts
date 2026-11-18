import { describe, expect, it } from "vitest";
import { normalizeSearchText, parseSearchQuery } from "../src/services/searchQuery";
import {
  buildQueryPlan,
  buildRelaxedPlan,
  type QueryClause,
} from "../src/services/searchWorkerQuery";

/** The words of the plan, as `presence term` strings, in order: easier to read than the objects. */
const asText = (clauses: QueryClause[]): string[] =>
  clauses.map(
    (c) =>
      `${c.presence === "excluded" ? "-" : ""}${c.phrase ? `"${c.term}"` : c.term}${c.prefix ? "*" : ""}`,
  );

const planOf = (query: string) => buildQueryPlan(parseSearchQuery(query));

describe("search query normalization", () => {
  it("parses phrases and terms case-insensitively", () => {
    expect(parseSearchQuery('"Dear Eliezer" FOO foo')).toMatchObject({
      phrases: ["dear eliezer"],
      terms: ["foo"],
    });
  });

  it("trims the punctuation typed against a term, and keeps a phrase as written (HVN-71)", () => {
    expect(parseSearchQuery("wombat, (Wombat) wombat.")).toMatchObject({
      phrases: [],
      terms: ["wombat"],
    });
    expect(parseSearchQuery('"hello, world" wombat,')).toMatchObject({
      phrases: ["hello, world"],
      terms: ["wombat"],
    });
  });

  it("normalizes searchable text for exact phrase verification", () => {
    expect(normalizeSearchText("Dear   Gemini,\nThis is a test")).toBe(
      "dear gemini, this is a test",
    );
  });
});

describe("parsing the words of a query (HVN-78)", () => {
  const texts = (query: string) => parseSearchQuery(query).required.map((t) => t.text);

  it("cuts a hyphenated word where the index cuts it, in order", () => {
    expect(texts("local-first")).toEqual(["local", "first"]);
    expect(parseSearchQuery("local-first").terms).toEqual(["local", "first"]);
    expect(texts("state-of-the-art")).toEqual(["state", "of", "the", "art"]);
  });

  it("breaks a word at a star inside it, so only a trailing star is a prefix", () => {
    expect(parseSearchQuery("foo*bar").required).toEqual([
      { text: "foo", prefix: false },
      { text: "bar", prefix: false },
    ]);
    expect(parseSearchQuery("foo*bar*").required).toEqual([
      { text: "foo", prefix: false },
      { text: "bar", prefix: true },
    ]);
    expect(parseSearchQuery('"foo*bar" "wombat*"').phrases).toEqual(["foo bar", "wombat"]);
  });

  it("keeps a word with a dot or a colon in it whole, as the index holds it", () => {
    expect(texts("node.js")).toEqual(["node.js"]);
    expect(texts("foo:bar")).toEqual(["foo:bar"]);
  });

  it("trims what is typed against a word, so c++ is c", () => {
    expect(texts("c++ templates")).toEqual(["c", "templates"]);
    expect(texts('(wombat), "')).toEqual(["wombat"]);
  });

  it("reads the operators the CLI documents, and only those", () => {
    expect(parseSearchQuery("alignment -rlhf")).toMatchObject({
      required: [{ text: "alignment", prefix: false }],
      excluded: ["rlhf"],
    });
    expect(parseSearchQuery("recurs*").required).toEqual([{ text: "recurs", prefix: true }]);
    expect(parseSearchQuery("kubernates~2").required).toEqual([
      { text: "kubernates", prefix: false, editDistance: 2 },
    ]);
    expect(parseSearchQuery("+must").required).toEqual([{ text: "must", prefix: false }]);
  });

  it("accepts ^N and ignores it: the index scores a whole query, not a word of it", () => {
    expect(parseSearchQuery("api^5 design").required).toEqual([
      { text: "api", prefix: false },
      { text: "design", prefix: false },
    ]);
    expect(parseSearchQuery("api^2.5").required).toEqual([{ text: "api", prefix: false }]);
    expect(parseSearchQuery("api^5").problem).toBeUndefined();
  });

  it("allows at most two edits: a longer distance costs seconds and matches everything", () => {
    expect(parseSearchQuery("internationalization~8").required[0].editDistance).toBe(2);
    expect(parseSearchQuery("wombat~3").required[0].editDistance).toBe(2);
    expect(parseSearchQuery("wombat~2").required[0].editDistance).toBe(2);
    expect(parseSearchQuery("wombat~1").required[0].editDistance).toBe(1);
  });

  it("takes modifiers in either order, and applies a prefix to the last part only", () => {
    expect(parseSearchQuery("fuzzy~1^2").required).toEqual([
      { text: "fuzzy", prefix: false, editDistance: 1 },
    ]);
    expect(parseSearchQuery("fuzzy^2~1").required).toEqual([
      { text: "fuzzy", prefix: false, editDistance: 1 },
    ]);
    expect(parseSearchQuery("local-fi*").required).toEqual([
      { text: "local", prefix: false },
      { text: "fi", prefix: true },
    ]);
  });

  it("does not list a word to leave out, or a spelling nearby, among the words to look for in a message", () => {
    const parsed = parseSearchQuery("alignment -rlhf kubernates~2");

    expect(parsed.terms).toEqual(["alignment"]);
  });

  it("says why there is nothing to look for, and not when there is", () => {
    expect(parseSearchQuery("").problem).toMatch(/Type a word/);
    expect(parseSearchQuery("* ~2 -").problem).toMatch(/Type a word/);
    expect(parseSearchQuery("-rlhf").problem).toMatch(/not only words to leave out/);
    expect(parseSearchQuery("wombat").problem).toBeUndefined();
    expect(parseSearchQuery('"to be"').problem).toBeUndefined();
  });

  it("says so when a query has more words and phrases than the index can be asked for", () => {
    const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

    expect(parseSearchQuery(words(100)).problem).toBeUndefined();
    expect(parseSearchQuery(words(101)).problem).toBe(
      "That is more than 100 words and phrases. Search for fewer of them.",
    );
    // Words to leave out and phrases count too.
    expect(parseSearchQuery(`${words(60)} ${words(60).replace(/word/g, "-out")}`).problem).toMatch(
      /more than 100/,
    );
    const phrases = Array.from({ length: 101 }, (_, i) => `"w${i} x"`).join(" ");
    expect(parseSearchQuery(phrases).problem).toMatch(/more than 100/);
  });

  it("does not read a minus before a quote as a phrase that is required", () => {
    // Leaving out a phrase is not supported; reading it as the phrase itself would turn the
    // search upside down without a word about it.
    for (const query of ['react -"class component"', '-"class component"', '"a b" -"c d"']) {
      expect(parseSearchQuery(query).problem).toBe(
        "Leaving out a phrase is not supported; use -word.",
      );
    }
    expect(parseSearchQuery('react "class component"').problem).toBeUndefined();
    expect(parseSearchQuery('well-"known"').problem).toBeUndefined();
  });
});

describe("planning the clauses (HVN-78)", () => {
  it("makes every word of the query required, and drops the stop words when it can", () => {
    expect(asText(planOf("Dear Eliezer").clauses)).toEqual(["eliezer"]);
    expect(planOf("Dear Eliezer").clauses.every((c) => c.presence === "required")).toBe(true);
  });

  it("keeps the stop words when they are all the query has", () => {
    expect(asText(planOf("to be or not").clauses)).toEqual(["to", "be", "or", "not"]);
  });

  it("drops a stop word that stands beside a phrase", () => {
    expect(asText(planOf('"eliezer yudkowsky" the').clauses)).toEqual(['"eliezer yudkowsky"']);
  });

  it("asks for a phrase whole, with its stop words, because the index matches it by position", () => {
    expect(planOf('"Dear Eliezer"').clauses).toEqual([
      { term: "dear eliezer", presence: "required", prefix: false, phrase: true },
    ]);
    expect(asText(planOf('"to be"').clauses)).toEqual(['"to be"']);
  });

  it("keeps a phrase as the index will cut it, hyphens and punctuation included", () => {
    expect(asText(planOf('"local-first software"').clauses)).toEqual(['"local-first software"']);
  });

  it("excludes the words typed with a minus, and prefixes the words typed with a star", () => {
    expect(asText(planOf("recurs* -rlhf").clauses)).toEqual(["recurs*", "-rlhf"]);
  });
});

describe("the relaxed plan, for a search that found nothing (HVN-78)", () => {
  const relaxed = (query: string) => buildRelaxedPlan(parseSearchQuery(query));

  it("asks for the prefixes of the words in lower case, as optional", () => {
    const plan = relaxed("FISH Hello");

    expect(asText(plan?.clauses ?? [])).toEqual(["fish*", "hello*"]);
    expect(plan?.clauses.every((c) => c.presence === "optional")).toBe(true);
  });

  it("trims the punctuation typed against a word (HVN-71)", () => {
    expect(asText(relaxed("runn,")?.clauses ?? [])).toEqual(["runn*"]);
    expect(asText(relaxed("(Fish), Hello!")?.clauses ?? [])).toEqual(["fish*", "hello*"]);
  });

  it("leaves out the stop words, so a question is not matched on how* alone", () => {
    expect(asText(relaxed("how should I migrate my database")?.clauses ?? [])).toEqual([
      "migrate*",
      "database*",
    ]);
  });

  it("keeps a word of three letters or more only, and every one of them when all are stop words", () => {
    expect(asText(relaxed("it is an ox")?.clauses ?? [])).toEqual([]);
    expect(relaxed("it is an ox")).toBeNull();
    expect(asText(relaxed("how should")?.clauses ?? [])).toEqual(["how*", "should*"]);
  });

  it("keeps the words to leave out, and has none for a phrase", () => {
    expect(asText(relaxed("fish -chips")?.clauses ?? [])).toEqual(["fish*", "-chips"]);
    expect(relaxed('"fish chips"')).toBeNull();
    expect(relaxed('"fish chips" soup')).toBeNull();
  });
});
