import { describe, expect, it } from "vitest";
import { buildForkedChat, LONG_OPENING } from "../testing/fixtures";
import { outputBranch } from "./get";

function contents(json: string): string[] {
  const parsed = JSON.parse(json) as { branch: { messages: Array<{ content: string }> } };
  return parsed.branch.messages.map((m) => m.content);
}

describe("haevn get (outputBranch)", () => {
  it("renders the branch that holds the given message, not the primary one", () => {
    expect(contents(outputBranch(buildForkedChat(), "u4", "json"))).toEqual([
      LONG_OPENING,
      "first answer",
      "follow up B",
    ]);
  });

  it("renders the primary branch when no message is given", () => {
    expect(contents(outputBranch(buildForkedChat(), undefined, "json"))).toEqual([
      LONG_OPENING,
      "first answer",
      "follow up A",
      "reply A",
    ]);
  });

  it("refuses a message the chat does not have", () => {
    expect(() => outputBranch(buildForkedChat(), "missing", "json")).toThrow(
      "No branch found containing message missing",
    );
  });
});
