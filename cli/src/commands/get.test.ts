import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { formatBranchAsMarkdown } from "../formatters/markdown";
import { buildForkedChat, LONG_OPENING } from "../testing/fixtures";
import { runAsTyped } from "../testing/runAsTyped";
import { consola } from "../utils/output";
import { getPrimaryBranch } from "../utils/tree";
import getCommand, { outputBranch } from "./get";

vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));

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

describe("haevn get --head and --tail with JSON (HVN-84)", () => {
  // The primary branch: LONG_OPENING, "first answer", "follow up A", "reply A".
  it("keeps the last N messages of the branch, as Markdown does", () => {
    expect(contents(outputBranch(buildForkedChat(), undefined, "json", { tail: 2 }))).toEqual([
      "follow up A",
      "reply A",
    ]);
    const markdown = outputBranch(buildForkedChat(), undefined, "markdown", { tail: 2 });
    expect(markdown).toContain("follow up A");
    expect(markdown).not.toContain("first answer");
  });

  it("keeps the first N messages, and head wins over tail when both are given", () => {
    expect(contents(outputBranch(buildForkedChat(), undefined, "json", { head: 2 }))).toEqual([
      LONG_OPENING,
      "first answer",
    ]);
    expect(
      contents(outputBranch(buildForkedChat(), undefined, "json", { head: 2, tail: 1 })),
    ).toEqual([LONG_OPENING, "first answer"]);
  });

  it("keeps the whole branch when N is 0 or at least its length", () => {
    expect(contents(outputBranch(buildForkedChat(), undefined, "json", { tail: 0 }))).toHaveLength(
      4,
    );
    expect(contents(outputBranch(buildForkedChat(), undefined, "json", { head: 9 }))).toHaveLength(
      4,
    );
  });

  it("counts the messages it keeps, and still lists the whole branch path", () => {
    const parsed = JSON.parse(outputBranch(buildForkedChat(), undefined, "json", { tail: 2 })) as {
      branch: { path: string[]; messageCount: number };
    };
    expect(parsed.branch.messageCount).toBe(2);
    expect(parsed.branch.path).toHaveLength(4);
  });

  it("cuts the same messages as the Markdown window over the same branch", () => {
    const chat = buildForkedChat();
    const path = getPrimaryBranch(chat);
    const kept = formatBranchAsMarkdown(chat, path, { head: 2 });
    expect(contents(outputBranch(chat, undefined, "json", { head: 2 }))).toEqual([
      LONG_OPENING,
      "first answer",
    ]);
    expect(kept).toContain("first answer");
    expect(kept).not.toContain("follow up A");
  });
});

describe("haevn get refuses a negative --head or --tail, either way (HVN-84)", () => {
  beforeEach(() => {
    vi.mocked(daemonRequest).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [["chat-1", "--head", "-1"], '--head must be a whole number, 0 or more (got "-1").'],
    [
      ["chat-1", "--tail", "-1", "-f", "json"],
      '--tail must be a whole number, 0 or more (got "-1").',
    ],
    [["chat-1", "-t", "-2"], '--tail must be a whole number, 0 or more (got "-2").'],
    [["chat-1", "--tail=-1"], '--tail must be a whole number, 0 or more (got "-1").'],
  ])("%j exits 1 with the message, before it asks the daemon", async (rawArgs, message) => {
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(runAsTyped(getCommand, rawArgs)).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(message);
    expect(daemonRequest).not.toHaveBeenCalled();
  });
});
