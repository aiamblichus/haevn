import { describe, expect, it } from "vitest";
import { parseWholeNumber } from "./args";

describe("parseWholeNumber", () => {
  it("returns the fallback when the flag is absent", () => {
    expect(parseWholeNumber("limit", undefined, 20, 1)).toBe(20);
    expect(parseWholeNumber("limit", "", 20, 1)).toBe(20);
  });

  it("parses a whole number at or above the minimum", () => {
    expect(parseWholeNumber("limit", "1", 20, 1)).toBe(1);
    expect(parseWholeNumber("offset", "0", 0)).toBe(0);
    expect(parseWholeNumber("limit", "250", 20, 1)).toBe(250);
  });

  it("refuses what the daemon would otherwise replace with its default", () => {
    for (const bad of ["abc", "-5", "2.5", "10x", " 3"]) {
      expect(() => parseWholeNumber("limit", bad, 20, 1)).toThrow(/--limit must be a whole number/);
    }
    expect(() => parseWholeNumber("limit", "0", 20, 1)).toThrow(/1 or more/);
  });
});
