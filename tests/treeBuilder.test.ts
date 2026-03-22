import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/model/haevn_model";
import { buildMessageTree, type TreeNode } from "../src/providers/shared/treeBuilder";

describe("buildMessageTree", () => {
  // Helper function to create a minimal ChatMessage from a tree node
  const nodeToMessage = (node: TreeNode<{ content: string }>): ChatMessage => ({
    id: node.id,
    parentId: node.parentId,
    childrenIds: [],
    message: [
      {
        kind: "request",
        parts: [
          {
            part_kind: "user-prompt",
            content: node.data.content,
            timestamp: new Date().toISOString(),
          },
        ],
      },
    ],
    model: "test",
    done: true,
    timestamp: Date.now(),
    chatId: "test-chat",
  });

  it("builds a linear tree (A → B → C)", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "first" } },
      { id: "2", parentId: "1", data: { content: "second" } },
      { id: "3", parentId: "2", data: { content: "third" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(rootIds).toEqual(["1"]);
    expect(Object.keys(messages).length).toBe(3);
    expect(messages["1"].childrenIds).toEqual(["2"]);
    expect(messages["2"].childrenIds).toEqual(["3"]);
    expect(messages["3"].childrenIds).toEqual([]);
    expect(messages["1"].parentId).toBeUndefined();
    expect(messages["2"].parentId).toBe("1");
    expect(messages["3"].parentId).toBe("2");
  });

  it("builds a branching tree (A → [B, C])", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "root" } },
      { id: "2", parentId: "1", data: { content: "child1" } },
      { id: "3", parentId: "1", data: { content: "child2" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(rootIds).toEqual(["1"]);
    expect(Object.keys(messages).length).toBe(3);
    expect(messages["1"].childrenIds).toHaveLength(2);
    expect(messages["1"].childrenIds).toContain("2");
    expect(messages["1"].childrenIds).toContain("3");
    expect(messages["2"].childrenIds).toEqual([]);
    expect(messages["3"].childrenIds).toEqual([]);
  });

  it("handles orphaned nodes (parent doesn't exist)", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: "999", data: { content: "orphan" } },
      { id: "2", parentId: undefined, data: { content: "valid-root" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    // Orphaned node should have parentId cleared and be added to roots
    expect(messages["1"].parentId).toBeUndefined();
    expect(rootIds).toContain("1");
    expect(rootIds).toContain("2");
    expect(rootIds.length).toBe(2);
  });

  it("builds a multi-root tree", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "root1" } },
      { id: "2", parentId: "1", data: { content: "child1" } },
      { id: "3", parentId: undefined, data: { content: "root2" } },
      { id: "4", parentId: "3", data: { content: "child2" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(rootIds).toHaveLength(2);
    expect(rootIds).toContain("1");
    expect(rootIds).toContain("3");
    expect(messages["1"].childrenIds).toEqual(["2"]);
    expect(messages["3"].childrenIds).toEqual(["4"]);
  });

  it("handles empty input", () => {
    const nodes: TreeNode<{ content: string }>[] = [];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(Object.keys(messages).length).toBe(0);
    expect(rootIds.length).toBe(0);
  });

  it("handles a single node", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "only" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(Object.keys(messages).length).toBe(1);
    expect(rootIds).toEqual(["1"]);
    expect(messages["1"].childrenIds).toEqual([]);
  });

  it("handles deep tree (A → B → C → D → E)", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "a" } },
      { id: "2", parentId: "1", data: { content: "b" } },
      { id: "3", parentId: "2", data: { content: "c" } },
      { id: "4", parentId: "3", data: { content: "d" } },
      { id: "5", parentId: "4", data: { content: "e" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(rootIds).toEqual(["1"]);
    expect(messages["1"].childrenIds).toEqual(["2"]);
    expect(messages["2"].childrenIds).toEqual(["3"]);
    expect(messages["3"].childrenIds).toEqual(["4"]);
    expect(messages["4"].childrenIds).toEqual(["5"]);
    expect(messages["5"].childrenIds).toEqual([]);
  });

  it("handles complex branching (A → B → [C, D], A → E)", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "a", parentId: undefined, data: { content: "root" } },
      { id: "b", parentId: "a", data: { content: "branch1" } },
      { id: "c", parentId: "b", data: { content: "leaf1" } },
      { id: "d", parentId: "b", data: { content: "leaf2" } },
      { id: "e", parentId: "a", data: { content: "branch2" } },
    ];

    const { messages, rootIds } = buildMessageTree(nodes, nodeToMessage);

    expect(rootIds).toEqual(["a"]);
    expect(messages["a"].childrenIds).toHaveLength(2);
    expect(messages["a"].childrenIds).toContain("b");
    expect(messages["a"].childrenIds).toContain("e");
    expect(messages["b"].childrenIds).toHaveLength(2);
    expect(messages["b"].childrenIds).toContain("c");
    expect(messages["b"].childrenIds).toContain("d");
  });

  it("preserves node data through transformation", () => {
    const nodes: TreeNode<{ content: string }>[] = [
      { id: "1", parentId: undefined, data: { content: "hello" } },
    ];

    const { messages } = buildMessageTree(nodes, nodeToMessage);

    // Check that the content from node.data made it through
    const message = messages["1"].message[0];
    if (message.kind === "request") {
      const part = message.parts[0];
      if (part.part_kind === "user-prompt") {
        expect(part.content).toBe("hello");
      }
    }
  });
});
