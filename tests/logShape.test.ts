import { describe, expect, it } from "vitest";
import { errorShape, scrubMessage } from "../src/utils/logShape";

const SENTINEL = "SENTINEL-HVN157";

function parseError(text: string): unknown {
  try {
    JSON.parse(text);
  } catch (err) {
    return err;
  }
  throw new Error("expected JSON.parse to throw");
}

describe("logShape keeps quoted content out (HVN-157)", () => {
  it("hides a quoted run that spans a line break", () => {
    expect(scrubMessage(`could not read "Dear ${SENTINEL}\nI am sad"`)).not.toContain(SENTINEL);
  });

  it("hides the text a JSON.parse error quotes, newline included", () => {
    const shape = JSON.stringify(errorShape(parseError(`Dear ${SENTINEL}\nI am sad`)));
    expect(shape).not.toContain(SENTINEL);
  });
});
