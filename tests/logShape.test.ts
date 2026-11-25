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
    // V8 quotes the first 10 characters of the text it could not parse: put the secret in them.
    const shape = JSON.stringify(errorShape(parseError("a\nSECRETX tail")));
    expect(shape).not.toContain("SECRETX");
  });
});
