import { describe, expect, it } from "vitest";
import { buildChat, buildForkedChat, LONG_OPENING } from "../testing/fixtures";
import {
  getAllBranches,
  getBranchContainingMessage,
  getMessageText,
  getPrimaryBranch,
} from "./tree";

describe("getAllBranches", () => {
  it("lists one branch per leaf, and marks the one that holds currentId as primary", () => {
    const branches = getAllBranches(buildForkedChat());
    const byLeaf = new Map(branches.map((b) => [b.leafMessageId, b] as const));

    expect([...byLeaf.keys()].sort()).toEqual(["a3", "a5"]);
    expect(byLeaf.get("a3")).toMatchObject({
      path: ["u0", "a1", "u2", "a3"],
      messageCount: 4,
      isPrimary: true,
    });
    expect(byLeaf.get("a5")).toMatchObject({
      path: ["u0", "a1", "u4", "a5"],
      messageCount: 4,
      isPrimary: false,
    });
  });

  it("gives each branch its first prompt, cut to 60 characters", () => {
    const branch = getAllBranches(buildForkedChat()).find((b) => b.leafMessageId === "a3");

    expect(branch?.firstPrompt).toBe(LONG_OPENING.slice(0, 60));
    expect(branch?.firstPrompt).toHaveLength(60);
  });
});

describe("branch lookup", () => {
  it("finds the primary branch from currentId, and the branch through a given message", () => {
    const chat = buildForkedChat();

    expect(getPrimaryBranch(chat)).toEqual(["u0", "a1", "u2", "a3"]);
    expect(getBranchContainingMessage(chat, "u4")).toEqual(["u0", "a1", "u4"]);
    expect(getBranchContainingMessage(chat, "missing")).toEqual([]);
  });
});

describe("getMessageText", () => {
  const thinking = `${"chain of thought ".repeat(20)}TAIL`;
  const chat = buildChat([
    { id: "u1", parentId: null, role: "user", text: "question" },
    { id: "a1", parentId: "u1", role: "assistant", text: "answer", thinking },
  ]);

  it("shows thinking as a 100-character preview unless asked for it in full", () => {
    const message = chat.messages.a1;

    expect(getMessageText(message)).toBe(`[thinking: ${thinking.slice(0, 100)}...]\n\nanswer`);
    expect(getMessageText(message, { includeThinking: true })).toBe(`${thinking}\n\nanswer`);
  });
});
