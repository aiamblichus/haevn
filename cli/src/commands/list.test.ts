import { describe, expect, it } from "vitest";
import { parseOffset } from "./list";

describe("haevn list --offset (HVN-14)", () => {
  it("is 0 when the flag is absent or empty", () => {
    expect(parseOffset(undefined)).toBe(0);
    expect(parseOffset("")).toBe(0);
  });

  it("reads a whole number, 0 or more", () => {
    expect(parseOffset("0")).toBe(0);
    expect(parseOffset("40")).toBe(40);
  });

  it.each(["-1", "1.5", "abc", "10x"])("refuses %s, which is not a whole number", (input) => {
    expect(() => parseOffset(input)).toThrow("--offset must be a whole number, 0 or more");
  });
});
