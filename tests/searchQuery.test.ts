import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIndexBuilder } from "../src/services/searchPipeline";
import { normalizeSearchText, parseSearchQuery } from "../src/services/searchQuery";
import {
  applyClauses,
  buildQueryPlan,
  buildRelaxedPlan,
  type QueryClause,
  queryNeedsExactPhrasePath,
} from "../src/services/searchWorkerQuery";

/** The words of the plan, as `presence term` strings, in order: easier to read than the objects. */
const asText = (clauses: QueryClause[]): string[] =>
  clauses.map((c) => `${c.presence === "excluded" ? "-" : ""}${c.term}${c.prefix ? "*" : ""}`);

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
    expect(parseSearchQuery("api^5 design").required).toEqual([
      { text: "api", prefix: false, boost: 5 },
      { text: "design", prefix: false },
    ]);
    expect(parseSearchQuery("+must").required).toEqual([{ text: "must", prefix: false }]);
  });

  it("takes modifiers in either order, and applies a prefix to the last part only", () => {
    expect(parseSearchQuery("fuzzy~1^2").required).toEqual([
      { text: "fuzzy", prefix: false, editDistance: 1, boost: 2 },
    ]);
    expect(parseSearchQuery("fuzzy^2~1").required[0]).toMatchObject({ editDistance: 1, boost: 2 });
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
    expect(asText(planOf('"eliezer yudkowsky" the').clauses)).toEqual(["eliezer", "yudkowsky"]);
  });

  it("marks stopword-bearing phrases for exact text verification", () => {
    expect(planOf('"Dear Eliezer"')).toMatchObject({
      hasPhrases: true,
      phraseConstraints: [
        {
          normalizedPhrase: "dear eliezer",
          terms: ["dear", "eliezer"],
          requiresTextVerification: true,
        },
      ],
    });
    expect(asText(planOf('"Dear Eliezer"').clauses)).toEqual(["eliezer"]);
  });

  it("keeps non-stopword phrases on the fast metadata path", () => {
    expect(planOf('"eliezer yudkowsky"')).toMatchObject({
      phraseConstraints: [
        {
          normalizedPhrase: "eliezer yudkowsky",
          terms: ["eliezer", "yudkowsky"],
          requiresTextVerification: false,
        },
      ],
    });
    expect(queryNeedsExactPhrasePath(parseSearchQuery('"eliezer yudkowsky"'))).toBe(false);
    expect(queryNeedsExactPhrasePath(parseSearchQuery('"dear eliezer"'))).toBe(true);
  });

  it("cuts the words of a phrase where the index cuts them", () => {
    expect(planOf('"local-first software"').phraseConstraints[0].terms).toEqual([
      "local",
      "first",
      "software",
    ]);
  });

  it("asks for a phrase of stop words by its words, and has the text confirm it", () => {
    const plan = planOf('"to be"');

    expect(asText(plan.clauses)).toEqual(["to", "be"]);
    expect(plan.phraseConstraints[0].requiresTextVerification).toBe(true);
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

describe("Lunr's own query parser (HVN-78)", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  }

  it("is never handed the text of a query: nothing in src calls search() on an index", () => {
    const offenders = sourceFiles("src").filter((file) =>
      /\b(?:index|idx|seg\.index)\.search\(/.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });
});

describe("putting the clauses on a Lunr query (HVN-78)", () => {
  function rank(boost: number): string[] {
    const builder = createIndexBuilder();
    builder.add({ id: "a", title: "t", content: "alpha" });
    builder.add({ id: "b", title: "t", content: "beta" });
    const index = builder.build();
    const clauses: QueryClause[] = [
      { term: "alpha", presence: "optional", prefix: false, boost },
      { term: "beta", presence: "optional", prefix: false },
    ];
    return index.query((q) => applyClauses(q, clauses)).map((r) => r.ref);
  }

  it("hands a boost to the index: the word that counts more puts its chat first", () => {
    expect(rank(10)[0]).toBe("a");
    expect(rank(0.1)[0]).toBe("b");
  });
});
