import { describe, expect, it } from "vitest";
import { safeText } from "./output";

const STAND_IN = "\uFFFD";

describe("safeText (HVN-58)", () => {
  it("replaces ESC, so a sequence cannot reach the terminal", () => {
    expect(safeText("\x1b")).toBe(STAND_IN);
  });

  it("replaces BEL", () => {
    expect(safeText("ring\x07")).toBe(`ring${STAND_IN}`);
  });

  it("replaces a CSI sequence, which moves the cursor or clears the line", () => {
    expect(safeText("\x1b[2K\x1b[1A")).toBe(`${STAND_IN}[2K${STAND_IN}[1A`);
  });

  it("replaces an OSC title sequence, which sets the window title", () => {
    expect(safeText("\x1b]0;pwned\x07")).toBe(`${STAND_IN}]0;pwned${STAND_IN}`);
  });

  it("replaces the C1 control CSI (U+009B), which a terminal may read as a sequence start", () => {
    expect(safeText("\x9b31mred")).toBe(`${STAND_IN}31mred`);
  });

  it("replaces DEL", () => {
    expect(safeText("a\x7fb")).toBe(`a${STAND_IN}b`);
  });

  it("replaces carriage return, which rewrites the start of the line", () => {
    expect(safeText("over\rwrite")).toBe(`over${STAND_IN}write`);
  });

  it("replaces the whole C1 range and leaves the no-break space (U+00A0) alone", () => {
    const c1 = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)).join("");
    expect(safeText(c1)).toBe(STAND_IN.repeat(0x20));
    expect(safeText(" ")).toBe(" ");
  });

  it("keeps newlines and tabs", () => {
    expect(safeText("line one\n\tline two\n")).toBe("line one\n\tline two\n");
  });

  it("leaves emoji and CJK text untouched", () => {
    const text = "🙂 漢字 かな 한국어 ✓ 👩🏽‍💻";
    expect(safeText(text)).toBe(text);
  });
});
