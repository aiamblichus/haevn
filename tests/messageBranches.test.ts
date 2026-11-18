import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import { currentBranchIds, openingBranch } from "../src/utils/messageBranches";

// [id, parentId, creation time]. Children are listed in the order given here.
type Spec = [string, string | undefined, number];

function makeTree(specs: Spec[], currentId?: string): Chat {
  const messages: Record<string, ChatMessage> = {};
  for (const [id, parentId, timestamp] of specs) {
    messages[id] = {
      id,
      parentId,
      childrenIds: [],
      message: [],
      model: "m",
      done: true,
      chatId: "c",
      timestamp,
    } as ChatMessage;
  }
  for (const [id, parentId] of specs) {
    if (parentId) messages[parentId].childrenIds.push(id);
  }
  return {
    id: "c",
    source: "claude",
    sourceId: "c",
    title: "t",
    currentId,
    messages,
  } as unknown as Chat;
}

// What the viewer's Thread does: from the root, take children[selection ?? 0] until a leaf.
function walkLikeTheViewer(chat: Chat, rootId: string, selections: Map<string, number>): string[] {
  const chain: string[] = [];
  let current: ChatMessage | undefined = chat.messages[rootId];
  while (current) {
    chain.push(current.id);
    const children = current.childrenIds.map((id) => chat.messages[id]).filter(Boolean);
    current = children[selections.get(current.id) ?? 0];
  }
  return chain;
}

//   q1 ── a1-first
//      └─ a1 ── q2-original ── a2-original
//            └─ q2-edited ── a2
const BRANCHED: Spec[] = [
  ["q1", undefined, 1],
  ["a1-first", "q1", 2],
  ["a1", "q1", 3],
  ["q2-original", "a1", 4],
  ["a2-original", "q2-original", 5],
  ["q2-edited", "a1", 6],
  ["a2", "q2-edited", 7],
];

describe("openingBranch", () => {
  it("opens on the later branch at every fork when currentId is on it", () => {
    const chat = makeTree(BRANCHED, "a2");
    const opening = openingBranch(chat);
    expect(opening.rootId).toBe("q1");
    expect([...opening.selections]).toEqual([
      ["q1", 1],
      ["a1", 1],
    ]);
    expect(walkLikeTheViewer(chat, "q1", opening.selections)).toEqual([
      "q1",
      "a1",
      "q2-edited",
      "a2",
    ]);
  });

  it("selects nothing when currentId is on the first branch everywhere", () => {
    const chat = makeTree(BRANCHED, "a1-first");
    const opening = openingBranch(chat);
    expect(opening.selections.size).toBe(0);
    expect(walkLikeTheViewer(chat, "q1", opening.selections)).toEqual(["q1", "a1-first"]);
  });

  it("opens on a currentId in the middle of a branch, below its forks only", () => {
    const chat = makeTree(BRANCHED, "a1");
    const opening = openingBranch(chat);
    expect([...opening.selections]).toEqual([["q1", 1]]);
    // The viewer shows the first child below a1 (q2-original); the fork above is what matters.
    expect(walkLikeTheViewer(chat, "q1", opening.selections).slice(0, 2)).toEqual(["q1", "a1"]);
  });

  it("follows the export when currentId is missing or unknown: the latest leaf", () => {
    for (const currentId of [undefined, "", "not-a-message"]) {
      const chat = makeTree(BRANCHED, currentId);
      const opening = openingBranch(chat);
      expect(currentBranchIds(chat)).toEqual(["q1", "a1", "q2-edited", "a2"]);
      expect(walkLikeTheViewer(chat, opening.rootId as string, opening.selections)).toEqual(
        currentBranchIds(chat),
      );
    }
  });

  it("names the root of the branch when there are several roots", () => {
    const chat = makeTree(
      [
        ["r1", undefined, 1],
        ["r1-a", "r1", 2],
        ["r2", undefined, 3],
        ["r2-a", "r2", 4],
        ["r2-b", "r2", 5],
      ],
      "r2-b",
    );
    const opening = openingBranch(chat);
    expect(opening.rootId).toBe("r2");
    expect([...opening.selections]).toEqual([["r2", 1]]);
  });

  it("counts positions among the children that exist, as the viewer does", () => {
    const chat = makeTree(
      [
        ["q", undefined, 1],
        ["x", "q", 2],
        ["y", "q", 3],
      ],
      "y",
    );
    chat.messages.q.childrenIds = ["gone", "x", "y"];
    const opening = openingBranch(chat);
    expect(opening.selections.get("q")).toBe(1);
    expect(walkLikeTheViewer(chat, "q", opening.selections)).toEqual(["q", "y"]);
  });

  it("leaves a fork alone when the parent does not list the step as a child", () => {
    const chat = makeTree(BRANCHED, "a2");
    chat.messages.a1.childrenIds = ["q2-original"]; // q2-edited is unlinked from a1
    const opening = openingBranch(chat);
    expect(opening.selections.has("a1")).toBe(false);
    expect(opening.selections.get("q1")).toBe(1);
  });

  it("has nothing to say about a chat with no messages", () => {
    const opening = openingBranch(makeTree([]));
    expect(opening.rootId).toBeUndefined();
    expect(opening.selections.size).toBe(0);
  });
});
