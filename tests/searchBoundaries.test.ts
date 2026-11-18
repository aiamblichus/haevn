import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const files = sourceFiles("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

// A MATCH that is not followed by a bound parameter: the text after it is built in the SQL.
const UNBOUND_MATCH = /\bMATCH\b(?!\s*\?)/;
const withoutComments = (text: string) =>
  text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("where the search index's boundaries are (HVN-87)", () => {
  it("lets only searchIndex.ts import SQLite", () => {
    const importers = files
      .filter((f) => /from\s+["']@sqlite\.org\/sqlite-wasm["']/.test(f.text))
      .map((f) => f.path);

    expect(importers).toEqual(["src/services/searchIndex.ts"]);
  });

  it("builds the text of a MATCH only in searchMatch.ts, from the plan", () => {
    // An FTS5 MATCH text is a query language of its own: a quote or an operator typed by the
    // reader must never reach it. Everything outside the builder hands SQL a bound parameter.
    const offenders = files
      .filter((f) => f.path !== "src/services/searchMatch.ts")
      .filter((f) => UNBOUND_MATCH.test(withoutComments(f.text)))
      .map((f) => f.path);

    expect(offenders).toEqual([]);
  });

  it("would see a MATCH written with an interpolated value", () => {
    expect(UNBOUND_MATCH.test("WHERE msgs MATCH " + "$" + "{query}")).toBe(true);
    expect(UNBOUND_MATCH.test("WHERE msgs MATCH ? AND rowid")).toBe(false);
  });
});
