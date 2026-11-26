import { describe, expect, it } from "vitest";
import {
  buildChat,
  buildNestedForkChat,
  buildThreeBranchChat,
  makeToolCall,
  makeToolReturn,
} from "../testing/fixtures";
import type { BinaryContent, ChatMessage, ModelResponsePart } from "../types/chat";
import {
  buildChatTree,
  getMessagePreview,
  getMessageText,
  toolStandIn,
  treeMessageIds,
} from "./tree";

describe("buildChatTree", () => {
  it("cuts a three-branch chat into the trunk and one section per branch, in stored order", () => {
    const tree = buildChatTree(buildThreeBranchChat());

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].messageIds).toEqual(["u0", "a1"]);
    expect(tree.roots[0].branches.map((b) => b.messageIds)).toEqual([
      ["u2", "a3"],
      ["u4", "a5"],
      ["u6", "a7"],
    ]);
    expect(tree.roots[0].branches.map((b) => b.holdsCurrent)).toEqual([false, true, false]);
    expect(tree.unlinked).toEqual([]);
  });

  it("nests a fork inside a branch", () => {
    const [trunk] = buildChatTree(buildNestedForkChat()).roots;

    expect(trunk.messageIds).toEqual(["u0", "a1"]);
    const [branchA, branchB] = trunk.branches;
    expect(branchA.messageIds).toEqual(["u2", "a3"]);
    expect(branchA.branches.map((b) => b.messageIds)).toEqual([
      ["u8", "a9"],
      ["u10", "a11"],
    ]);
    expect(branchB.messageIds).toEqual(["u4", "a5"]);
    expect([branchA.holdsCurrent, branchB.holdsCurrent]).toEqual([true, false]);
    expect(branchA.branches.map((b) => b.holdsCurrent)).toEqual([false, true]);
  });

  it("runs a chat with no fork as one section with no branches", () => {
    const chat = buildChat([
      { id: "u1", parentId: null, role: "user", text: "hi" },
      { id: "a1", parentId: "u1", role: "assistant", text: "hello" },
    ]);

    expect(buildChatTree(chat).roots).toEqual([
      { messageIds: ["u1", "a1"], branches: [], holdsCurrent: true },
    ]);
  });

  it("holds no current branch at a fork when currentId is before it", () => {
    const chat = buildThreeBranchChat();
    chat.currentId = "a1";

    expect(buildChatTree(chat).roots[0].branches.map((b) => b.holdsCurrent)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it("reads several roots as sections of their own", () => {
    const chat = buildChat([
      { id: "u1", parentId: null, role: "user", text: "first beginning" },
      { id: "a1", parentId: "u1", role: "assistant", text: "one" },
      { id: "u2", parentId: null, role: "user", text: "second beginning" },
      { id: "a2", parentId: "u2", role: "assistant", text: "two" },
    ]);

    expect(buildChatTree(chat).roots.map((r) => r.messageIds)).toEqual([
      ["u1", "a1"],
      ["u2", "a2"],
    ]);
  });

  it("loses no message to a cycle or a link its parent does not keep, and walks none twice", () => {
    const chat = buildThreeBranchChat();
    // a7 also lists a1 as a child, which closes a cycle; a ghost child id is ignored
    chat.messages.a7.childrenIds.push("a1", "ghost");
    // a message whose parent link names a message that does not list it back
    chat.messages.u9 = { ...chat.messages.u6, id: "u9", parentId: "a3", childrenIds: [] };

    const tree = buildChatTree(chat);
    const ids = treeMessageIds(tree);

    expect([...ids].sort()).toEqual(Object.keys(chat.messages).sort());
    expect(new Set(ids).size).toBe(ids.length);
    expect(tree.unlinked).toEqual(["u9"]);
  });
});

describe("treeMessageIds", () => {
  it("lists the trunk, then each branch whole, in the order a reader meets them", () => {
    expect(treeMessageIds(buildChatTree(buildNestedForkChat()))).toEqual([
      "u0",
      "a1",
      "u2",
      "a3",
      "u8",
      "a9",
      "u10",
      "a11",
      "u4",
      "a5",
    ]);
  });
});

const TIME = "2026-01-01T00:00:00.000Z";
const IMAGE: BinaryContent = { kind: "binary", data: "", media_type: "image/png" };

function reply(parts: ModelResponsePart[]): ChatMessage {
  return {
    id: "a1",
    chatId: "chat-1",
    childrenIds: [],
    model: "fixture-model",
    done: true,
    message: [{ kind: "response", parts, timestamp: TIME }],
  };
}

describe("a message of tool traffic only (ChatGPT's tool returns)", () => {
  it("stands [tool result] for a tool-return and no text", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "u2", "page text");

    expect(getMessageText(chat.messages.u2)).toBe("");
    expect(toolStandIn(chat.messages.u2)).toBe("[tool result]");
    expect(getMessagePreview(chat.messages.u2)).toBe("[tool result]");
  });

  it("stands [tool result] for a tool-return with empty content too", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "u2", "");

    expect(toolStandIn(chat.messages.u2)).toBe("[tool result]");
  });

  it("stands [tool call] for a reply that is only a tool call", () => {
    const chat = makeToolCall(buildThreeBranchChat(), "a1");

    expect(toolStandIn(chat.messages.a1)).toBe("[tool call]");
    expect(getMessagePreview(chat.messages.a1)).toBe("[tool call]");
  });

  it("stands nothing for a message with text or media, or for a plain blank one", () => {
    const withText = reply([
      { part_kind: "tool-call", tool_name: "browser", tool_call_id: "c" },
      { part_kind: "text", content: "Searching." },
    ]);
    const withImage = reply([
      { part_kind: "tool-call", tool_name: "dalle", tool_call_id: "c" },
      { part_kind: "image-response", content: IMAGE },
    ]);

    expect(toolStandIn(withText)).toBeUndefined();
    expect(getMessagePreview(withText)).toBe("Searching.");
    expect(toolStandIn(withImage)).toBeUndefined();
    expect(getMessagePreview(withImage)).toBe("[image]");
    expect(toolStandIn(reply([]))).toBeUndefined();
    expect(getMessagePreview(reply([]))).toBe("");
  });
});
