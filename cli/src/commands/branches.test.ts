import { describe, expect, it } from "vitest";
import { buildThreeBranchChat, makeToolCall, makeToolReturn } from "../testing/fixtures";
import { formatBranchesJson, formatTreeText } from "./branches";

/** The tree as the terminal shows it, without colour. */
function tree(chat = buildThreeBranchChat()): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
  return formatTreeText(chat).replace(/\u001b\[[0-9;]*m/g, "");
}

describe("haevn branches with tool messages (ChatGPT's tool returns)", () => {
  it("shows a tool result as a [tool] row with a stand-in, not as an empty [user] row", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "u2", "search plumbing");

    const text = tree(chat);

    expect(text).toMatch(/\[tool\] \[tool result\]/);
    expect(text).not.toContain("search plumbing");
    // the rows that are real prompts still say [user]
    expect(text).toMatch(/\[user\] ask B/);
    expect(text.match(/\[user\]\s*$/gm)).toBeNull();
  });

  it("shows a reply that is only a tool call as [tool] [tool call]", () => {
    const chat = makeToolCall(buildThreeBranchChat(), "a3");

    expect(tree(chat)).toMatch(/\[tool\] \[tool call\]/);
  });

  it("names the tool message in the primary-branch line by a T, not a U or an A", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "a5", "x");
    chat.currentId = "a5";

    expect(tree(chat)).toContain("T:[tool result]");
  });

  it("keeps the row's role in the JSON, and the stand-in in its preview", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "u2", "search plumbing");
    const parsed = JSON.parse(formatBranchesJson(chat)) as {
      tree: {
        children: Array<{ children: Array<{ role: string; preview: string; content: string }> }>;
      };
    };

    const row = parsed.tree.children[0].children[0];
    expect(row).toMatchObject({ role: "user", preview: "[tool result]", content: "" });
  });
});
