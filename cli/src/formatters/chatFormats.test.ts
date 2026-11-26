import { describe, expect, it } from "vitest";
import {
  buildChat,
  buildNestedForkChat,
  buildThreeBranchChat,
  type FixtureTurn,
  makeToolCall,
  makeToolReturn,
} from "../testing/fixtures";
import { resolveMessageRef } from "../utils/messageRefs";
import { formatChatAsJson, toJsonString } from "./json";
import { formatChatAsMarkdown } from "./markdown";

/** The headings of a Markdown document, in order. */
function headings(markdown: string): string[] {
  return markdown.match(/^#{1,3} .+$/gm) ?? [];
}

/** How many times `text` appears as a whole line. */
function lines(markdown: string, text: string): number {
  return markdown.split("\n").filter((line) => line === text).length;
}

describe("formatChatAsMarkdown", () => {
  it("writes the trunk once, then each of three branches under its own heading, marking the current one", () => {
    const out = formatChatAsMarkdown(buildThreeBranchChat(), { includeMetadata: false });

    expect(headings(out)).toEqual([
      "# Fixture chat",
      "## User",
      "## Assistant",
      "### Branch 1 of 3",
      "## User",
      "## Assistant",
      "### Branch 2 of 3 (current)",
      "## User",
      "## Assistant",
      "### Branch 3 of 3",
      "## User",
      "## Assistant",
    ]);
    expect(out).toBe(
      [
        "# Fixture chat",
        "",
        "## User",
        "",
        "Draw a robot",
        "",
        "## Assistant",
        "",
        "trunk answer",
        "",
        "### Branch 1 of 3",
        "",
        "## User",
        "",
        "ask A",
        "",
        "## Assistant",
        "",
        "reply A",
        "",
        "### Branch 2 of 3 (current)",
        "",
        "## User",
        "",
        "ask B",
        "",
        "## Assistant",
        "",
        "reply B",
        "",
        "### Branch 3 of 3",
        "",
        "## User",
        "",
        "ask C",
        "",
        "## Assistant",
        "",
        "reply C",
        "",
        "---",
        "",
        "_8 messages · 3 branches_",
      ].join("\n"),
    );
  });

  it("shows every message exactly once", () => {
    const out = formatChatAsMarkdown(buildThreeBranchChat());

    for (const text of [
      "Draw a robot",
      "trunk answer",
      "ask A",
      "reply A",
      "ask B",
      "reply B",
      "ask C",
      "reply C",
    ]) {
      expect(lines(out, text)).toBe(1);
    }
  });

  it("numbers a fork inside a branch under that branch, at the same heading level", () => {
    const out = formatChatAsMarkdown(buildNestedForkChat(), { includeMetadata: false });

    expect(headings(out).filter((h) => h.startsWith("###"))).toEqual([
      "### Branch 1 of 2 (current)",
      "### Branch 1.1 of 2",
      "### Branch 1.2 of 2 (current)",
      "### Branch 2 of 2",
    ]);
    // The branch's own messages come before its sub-branches, and branch 2 after all of branch 1
    const order = ["reply A", "ask A1", "reply A1", "ask A2", "reply A2", "ask B", "reply B"].map(
      (text) => out.indexOf(`\n${text}\n`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(lines(out, "reply A")).toBe(1);
    expect(lines(out, "ask A2")).toBe(1);
  });

  it("marks no branch when the chat is open before the fork", () => {
    const chat = buildThreeBranchChat();
    chat.currentId = "a1";

    expect(formatChatAsMarkdown(chat)).not.toContain("(current)");
  });

  it("writes a chat that never forks as the plain conversation", () => {
    const chat = buildChat([
      { id: "u1", parentId: null, role: "user", text: "hi" },
      { id: "a1", parentId: "u1", role: "assistant", text: "hello" },
    ]);

    const out = formatChatAsMarkdown(chat, { includeMetadata: false });

    expect(headings(out)).toEqual(["# Fixture chat", "## User", "## Assistant"]);
    expect(out).toContain("_2 messages_");
  });

  it("reads several roots as branches of a fork at the start", () => {
    const chat = buildChat([
      { id: "u1", parentId: null, role: "user", text: "first beginning" },
      { id: "a1", parentId: "u1", role: "assistant", text: "one" },
      { id: "u2", parentId: null, role: "user", text: "second beginning" },
      { id: "a2", parentId: "u2", role: "assistant", text: "two" },
    ]);

    const out = formatChatAsMarkdown(chat, { includeMetadata: false });

    expect(headings(out).filter((h) => h.startsWith("###"))).toEqual([
      "### Branch 1 of 2",
      "### Branch 2 of 2 (current)",
    ]);
  });

  it("puts the older of several beginnings first, whatever the order they are stored in", () => {
    const chat = buildChat([
      { id: "u1", parentId: null, role: "user", text: "the newer beginning" },
      { id: "u2", parentId: null, role: "user", text: "the older beginning" },
    ]);
    chat.messages.u1.timestamp = 2000;
    chat.messages.u2.timestamp = 1000;

    const out = formatChatAsMarkdown(chat, { includeMetadata: false });

    expect(out.indexOf("the older beginning")).toBeLessThan(out.indexOf("the newer beginning"));
    expect(out).toContain("### Branch 1 of 2 (current)\n\n## User\n\nthe older beginning");
  });

  it("writes a chat with a fork at each of 5,000 messages, headings numbered all the way down", () => {
    const turns: FixtureTurn[] = [];
    for (let i = 0; i < 5000; i++) {
      const parentId = i === 0 ? null : `s${i - 1}`;
      turns.push({ id: `s${i}`, parentId, role: i % 2 ? "assistant" : "user", text: `spine ${i}` });
      if (i > 0)
        turns.push({
          id: `l${i}`,
          parentId,
          role: i % 2 ? "user" : "assistant",
          text: `leaf ${i}`,
        });
    }

    const out = formatChatAsMarkdown(buildChat(turns), { includeMetadata: false });

    const branchHeadings = out.match(/^### Branch .+$/gm) ?? [];
    expect(branchHeadings).toHaveLength(2 * 4999);
    expect(branchHeadings[0]).toBe("### Branch 1 of 2 (current)");
    expect(branchHeadings[1]).toBe("### Branch 1.1 of 2 (current)");
    const ones = (n: number): string => Array(n).fill(1).join(".");
    // the spine runs down to the last fork, where the current message is the leaf
    expect(branchHeadings[4998]).toBe(`### Branch ${ones(4999)} of 2`);
    expect(branchHeadings[4999]).toBe(`### Branch ${ones(4998)}.2 of 2 (current)`);
    expect(out.match(/^## (User|Assistant)$/gm)).toHaveLength(5000 + 4999);
  });

  it("keeps a message no link reaches, under its own heading", () => {
    const chat = buildThreeBranchChat();
    chat.messages.u9 = {
      ...chat.messages.u6,
      id: "u9",
      parentId: "a3",
      childrenIds: [],
    };
    chat.messages.u9.message = chat.messages.u0.message;

    const out = formatChatAsMarkdown(chat, { includeMetadata: false });

    expect(out).toContain("### Unlinked messages");
    expect(lines(out, "Draw a robot")).toBe(2);
  });

  it("leaves out tool calls and results as a branch always has, and says so under a branch with nothing else", () => {
    const chat = buildThreeBranchChat();
    makeToolReturn(chat, "u2", "internal plumbing");
    makeToolCall(chat, "a3");

    const out = formatChatAsMarkdown(chat, { includeMetadata: false });

    expect(out).not.toContain("internal plumbing");
    expect(out).toContain(
      "### Branch 1 of 3\n\n_This branch holds no text, only tool calls or results._\n\n### Branch 2 of 3 (current)",
    );
    // the other two branches still show their text
    expect(lines(out, "reply B")).toBe(1);
    expect(lines(out, "reply C")).toBe(1);
  });

  it("skips system prompts with skipSystem, and links media from mediaText", () => {
    const chat = buildThreeBranchChat();
    chat.system = "Be brief.";
    chat.messages.a5.message = [
      {
        kind: "response",
        timestamp: "2026-01-01T00:00:00.000Z",
        parts: [
          { part_kind: "text", content: "reply B" },
          {
            part_kind: "image-response",
            content: { kind: "binary", data: "media/chat-1/x.png", media_type: "image/png" },
          },
        ],
      },
    ];

    const out = formatChatAsMarkdown(chat, {
      skipSystem: true,
      mediaText: new Map([["a5", ["![image](chat-media/01.png)"]]]),
    });

    expect(out).not.toContain("Be brief.");
    expect(out).toContain("reply B\n\n![image](chat-media/01.png)");
  });
});

interface WholeChatJson {
  chatId: string;
  currentRef: string | null;
  branchCount: number;
  messageCount: number;
  branch?: unknown;
  messages: Array<{
    ref: string;
    parentRef: string | null;
    childRefs: string[];
    role: string;
    content: string;
    media?: unknown;
  }>;
}

function parsed(chat: Parameters<typeof formatChatAsJson>[0], options = {}): WholeChatJson {
  return JSON.parse(toJsonString(formatChatAsJson(chat, options))) as WholeChatJson;
}

describe("formatChatAsJson", () => {
  it("lists every message once, in reading order, with its parent and children and the current message", () => {
    const chat = buildThreeBranchChat();
    const out = parsed(chat);
    const ref = (id: string): string => out.messages.find((m) => m.content === id)?.ref ?? "";

    expect(out.chatId).toBe("chat-1");
    expect(out.branchCount).toBe(3);
    expect(out.messageCount).toBe(8);
    expect(out.branch).toBeUndefined();
    expect(out.messages.map((m) => m.content)).toEqual([
      "Draw a robot",
      "trunk answer",
      "ask A",
      "reply A",
      "ask B",
      "reply B",
      "ask C",
      "reply C",
    ]);
    expect(out.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const trunk = out.messages[1];
    expect(trunk.parentRef).toBe(ref("Draw a robot"));
    expect(trunk.childRefs).toEqual([ref("ask A"), ref("ask B"), ref("ask C")]);
    expect(out.messages[0].parentRef).toBeNull();
    expect(out.messages[7].childRefs).toEqual([]);
    expect(out.currentRef).toBe(ref("reply B"));
  });

  it("gives refs that `get -m` resolves back to the stored messages", () => {
    const chat = buildThreeBranchChat();
    const out = parsed(chat);

    expect(out.messages.map((m) => resolveMessageRef(chat, m.ref).messageId)).toEqual([
      "u0",
      "a1",
      "u2",
      "a3",
      "u4",
      "a5",
      "u6",
      "a7",
    ]);
  });

  it("keeps tool calls and results in the list, so the links stay whole", () => {
    const chat = makeToolReturn(buildThreeBranchChat(), "u2", "internal plumbing");

    const out = parsed(chat);

    expect(out.messageCount).toBe(8);
    expect(out.messages[2]).toMatchObject({ role: "user", content: "" });
  });

  it("says currentRef is null when the chat's current message is not in it", () => {
    const chat = buildThreeBranchChat();
    chat.currentId = "ghost";

    const out = parsed(chat);

    expect(out.currentRef).toBeNull();
    expect(out.messageCount).toBe(8);
  });

  it("carries each message's media, and leaves out system messages with skipSystem", () => {
    const chat = buildChat([
      { id: "sys", parentId: null, role: "system", text: "Be brief." },
      { id: "u1", parentId: "sys", role: "user", text: "hi" },
    ]);
    const media = new Map([["u1", [{ kind: "image", bytes: 3, data: "AQID" }]]]);

    const out = parsed(chat, { media, skipSystem: true });

    expect(out.messages.map((m) => m.content)).toEqual(["hi"]);
    expect(out.messages[0].media).toEqual([{ kind: "image", bytes: 3, data: "AQID" }]);
    expect(out.messageCount).toBe(1);
  });
});
