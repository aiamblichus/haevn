import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as dbModule from "../src/services/db";

// Handlers and pages may not open the Dexie database (HVN-21). Biome's noRestrictedImports
// (biome.jsonc) names the module's value exports, because Biome 2.3 cannot exempt a type-only
// import on its own. This test fails when services/db gains a value export the rule does not name.
describe("the handlers-and-pages rule for services/db (HVN-21)", () => {
  it("names every value export of services/db, and nothing it does not export", () => {
    const config = readFileSync("biome.jsonc", "utf8");
    const pattern = /"importNamePattern":\s*"([^"]+)"/.exec(config)?.[1];
    if (!pattern) throw new Error("biome.jsonc has no importNamePattern for services/db");

    // The namespace-import alternative (`\\*`) is not a name; the rest are the export names.
    const named = pattern
      .split("|")
      .filter((alternative) => !alternative.includes("*"))
      .sort();

    expect(named).toEqual(Object.keys(dbModule).sort());
  });
});
