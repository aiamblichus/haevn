import { describe, expect, it } from "vitest";
import { foldName, isSafeFileName, StemAllocator, stemOf } from "./layout.js";

describe("stemOf", () => {
  it("is the id as a URI component: ASCII, with no separator in it", () => {
    expect(stemOf("claude:a1-b_2.c")).toBe("claude%3Aa1-b_2.c");
    expect(stemOf("a/b\\c d")).toBe("a%2Fb%5Cc%20d");
    expect(stemOf("ß日本")).toBe("%C3%9F%E6%97%A5%E6%9C%AC");
  });

  it("never names the directory it is in or the one above", () => {
    expect(stemOf(".")).toBe("%2E");
    expect(stemOf("..")).toBe("%2E%2E");
    expect(stemOf("...")).toBe("%2E%2E%2E");
    expect(stemOf("a..")).toBe("a..");
  });

  it("refuses an id that has no name", () => {
    expect(() => stemOf("")).toThrow(/empty/);
    expect(() => stemOf("lone\uD800surrogate")).toThrow(/not valid text/);
  });

  it("cuts an id too long for a file name, and keeps two long ids apart", () => {
    const a = stemOf(`${"x".repeat(300)}a`);
    const b = stemOf(`${"x".repeat(300)}b`);
    expect(a.length).toBeLessThanOrEqual(180);
    expect(a).not.toBe(b);
    expect(a).toMatch(/~[0-9a-f]{16}$/);
  });
});

describe("StemAllocator", () => {
  it("keeps the plain stem for the first of ids that differ only by case, and numbers the rest", () => {
    const names = new StemAllocator();
    expect([names.assign("Abc"), names.assign("abc"), names.assign("ABC")]).toEqual([
      "Abc",
      "abc~2",
      "ABC~3",
    ]);
  });

  it("does not hand out a name that is another id's own stem", () => {
    const names = new StemAllocator();
    expect([names.assign("abc"), names.assign("ABC"), names.assign("abc~2")]).toEqual([
      "abc",
      "ABC~2",
      "abc~2~2",
    ]);
  });

  it("treats a composed and a decomposed accent as one name, as APFS does", () => {
    const names = new StemAllocator();
    expect(foldName("é")).toBe(foldName("é"));
    expect(foldName("ABC.Png")).toBe("abc.png");
    expect(names.assign("café")).toBe("caf%C3%A9");
  });
});

describe("isSafeFileName", () => {
  it("accepts a name that is one path segment, any script", () => {
    for (const name of ["a.png", "msg_1.png", "изображение.png", ".hidden", "a b"]) {
      expect(isSafeFileName(name)).toBe(true);
    }
  });

  it("refuses a separator, a dot name, an empty name and a NUL", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b", "../x", "a\0b"]) {
      expect(isSafeFileName(name)).toBe(false);
    }
  });
});
