import { describe, expect, it } from "vitest";
import { flagText, parseWholeNumber } from "./args";

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

describe("flagText (HVN-84)", () => {
  it("is the parsed value for a flag typed with a value that is not a flag", () => {
    expect(flagText("40", ["--offset", "40"], ["--offset"])).toBe("40");
    expect(flagText("40", ["--offset=40"], ["--offset"])).toBe("40");
  });

  it("is undefined when the flag is absent, and empty when it has no value", () => {
    expect(flagText(undefined, ["chat-1"], ["--offset"])).toBeUndefined();
    expect(flagText("", ["--offset"], ["--offset"])).toBe("");
  });

  it("reads the token citty took for a flag, so a negative value is refused, not dropped", () => {
    // citty leaves `--offset` empty and reads `-1` as a flag named 1.
    const text = flagText("", ["--offset", "-1"], ["--offset"]);
    expect(text).toBe("-1");
    expect(() => parseWholeNumber("offset", text, 0)).toThrow(
      '--offset must be a whole number, 0 or more (got "-1").',
    );
  });

  it("reads the short alias too", () => {
    expect(flagText("", ["-l", "-3"], ["--limit", "-l"])).toBe("-3");
  });
});
