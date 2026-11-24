import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage, ModelResponsePart } from "../src/model/haevn_model";
import type {
  ChatGPTRawExtraction,
  OpenAIConversation,
  OpenAIConversationNode,
} from "../src/providers/chatgpt/model";
import { transformOpenAIToHaevn } from "../src/providers/chatgpt/transformer";
import { checkChat } from "../src/providers/shared/chatInvariants";

// HVN-147: `haevn health` failed ChatGPT chats with `text.empty`. The site keeps a model's reasoning
// in `thoughts[]` (a `thoughts` node) and a duration label in `content` (a `reasoning_recap` node),
// and the transformer read `.text` of both; and it writes assistant `text` nodes with `parts: [""]`
// that became empty parts. The shapes here are invented text on the fields the site really sends.

type Content = Record<string, unknown>;

interface Spec {
  id: string;
  parent: string | null;
  role?: "user" | "assistant" | "tool";
  content?: Content;
  metadata?: Record<string, unknown>;
}

const text = (...parts: string[]): Content => ({ content_type: "text", parts });
const thoughts = (items: Content[]): Content => ({
  content_type: "thoughts",
  thoughts: items,
  source_analysis_msg_id: "src-1",
});
const recap = (label: string): Content => ({ content_type: "reasoning_recap", content: label });

function raw(specs: Spec[], currentNode: string): ChatGPTRawExtraction {
  const mapping: Record<string, unknown> = {
    root: { id: "root", message: null, parent: null, children: [] },
  };
  for (const [i, spec] of specs.entries()) {
    mapping[spec.id] = {
      id: spec.id,
      parent: spec.parent ?? "root",
      children: [],
      message: {
        id: spec.id,
        author: { role: spec.role ?? "assistant" },
        create_time: 1_700_000_000 + i,
        update_time: 1_700_000_000 + i,
        content: spec.content ?? text("answer"),
        status: "finished_successfully",
        end_turn: true,
        weight: 1,
        metadata: { model_slug: "gpt-5", ...spec.metadata },
        recipient: "all",
        channel: null,
      },
    };
  }
  for (const spec of specs) {
    const parent = (mapping[spec.parent ?? "root"] as { children: string[] }) ?? undefined;
    parent?.children.push(spec.id);
  }
  const conversation = {
    id: "chat-1",
    conversation_id: "chat-1",
    title: "A chat with reasoning",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: currentNode,
    mapping: mapping as Record<string, OpenAIConversationNode>,
    moderation_results: [],
    is_archived: false,
    is_starred: null,
    is_do_not_remember: null,
    safe_urls: [],
    blocked_urls: [],
  } as unknown as OpenAIConversation;
  return { conversation, assets: {} } as ChatGPTRawExtraction;
}

function responseParts(message: ChatMessage): ModelResponsePart[] {
  return message.message.flatMap((m) => (m.kind === "response" ? m.parts : []));
}

function thinkingOf(chat: Chat, id: string): string[] {
  return responseParts(chat.messages[id])
    .filter((p) => p.part_kind === "thinking")
    .map((p) => (p as { content: string }).content);
}

/** The findings that HVN-147 is about: what the health check calls the damage and the oddity. */
function findingCodes(chat: Chat): string[] {
  return checkChat(chat).map((f) => f.code);
}

// The shape ohm measured: a blank assistant node (a0) after the prompt, thoughts with two steps,
// a recap, the answer, and a blank leaf (a2) that is the current node; an empty `thoughts: []`
// node (t0) sits between the prompt and a0.
function ohmsChat(): Chat {
  return transformOpenAIToHaevn(
    raw(
      [
        { id: "u1", parent: "root", role: "user", content: text("hi") },
        { id: "t0", parent: "u1", content: thoughts([]) },
        { id: "a0", parent: "t0", content: text("") },
        {
          id: "t1",
          parent: "a0",
          content: thoughts([
            { summary: "S1", content: "C1", chunks: ["C", "1"], finished: true },
            { summary: "", content: "C2", chunks: [], finished: true },
          ]),
        },
        { id: "r1", parent: "t1", content: recap("Thought for 4s") },
        { id: "a1", parent: "r1", content: text("answer") },
        { id: "a2", parent: "a1", content: text("") },
      ],
      "a2",
    ),
  );
}

describe("ChatGPT reasoning nodes (HVN-147)", () => {
  it("reads a thoughts node from thoughts[], one paragraph per step", () => {
    const chat = ohmsChat();
    expect(thinkingOf(chat, "t1")).toEqual(["**S1**\n\nC1\n\nC2"]);
  });

  it("keeps the 'Thought for N s' recap as its own thinking part", () => {
    const chat = ohmsChat();
    expect(thinkingOf(chat, "r1")).toEqual(["Thought for 4s"]);
  });

  it("falls back to the streamed chunks, and shows a summary or a body alone", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          { id: "u1", parent: "root", role: "user", content: text("hi") },
          {
            id: "t1",
            parent: "u1",
            content: thoughts([
              { summary: "Only a heading", content: "", chunks: [], finished: true },
              { summary: "Streamed", content: "", chunks: ["Part ", "one"], finished: true },
              { summary: null, content: "Only a body", finished: true },
            ]),
          },
          { id: "a1", parent: "t1", content: text("answer") },
        ],
        "a1",
      ),
    );
    expect(thinkingOf(chat, "t1")).toEqual([
      "**Only a heading**\n\n**Streamed**\n\nPart one\n\nOnly a body",
    ]);
  });

  it("splices out the blank assistant nodes: no message lost, the children re-parented", () => {
    const chat = ohmsChat();
    expect(Object.keys(chat.messages).sort()).toEqual(["a1", "r1", "t1", "u1"]);
    expect(chat.messages.t1.parentId).toBe("u1");
    expect(chat.messages.u1.childrenIds).toEqual(["t1"]);
    expect(chat.messages.a1.parentId).toBe("r1");
    expect(chat.messages.a1.childrenIds).toEqual([]);
  });

  it("moves current_node from a spliced node to its nearest kept ancestor", () => {
    expect(ohmsChat().currentId).toBe("a1");
  });

  it("leaves the chat with no text.empty, message.empty-parts or tree.* finding", () => {
    const codes = findingCodes(ohmsChat());
    expect(codes.filter((c) => c === "text.empty" || c === "message.empty-parts")).toEqual([]);
    expect(codes.filter((c) => c.startsWith("tree."))).toEqual([]);
  });

  it("keeps every branch when a blank node forks the tree", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          { id: "u1", parent: "root", role: "user", content: text("hi") },
          { id: "b0", parent: "u1", content: text("") },
          { id: "x1", parent: "b0", content: text("first answer") },
          { id: "y1", parent: "b0", content: text("second answer") },
          { id: "b1", parent: "y1", content: text("") },
          { id: "b2", parent: "b1", content: text("  ") },
          { id: "y2", parent: "b2", role: "user", content: text("go on") },
        ],
        "y2",
      ),
    );
    expect(Object.keys(chat.messages).sort()).toEqual(["u1", "x1", "y1", "y2"]);
    expect(chat.messages.x1.parentId).toBe("u1");
    expect(chat.messages.y1.parentId).toBe("u1");
    expect(chat.messages.u1.childrenIds.sort()).toEqual(["x1", "y1"]);
    expect(chat.messages.y2.parentId).toBe("y1");
    expect(chat.currentId).toBe("y2");
    expect(findingCodes(chat).filter((c) => c.startsWith("tree."))).toEqual([]);
  });

  it("does not splice a blank assistant node that is a tool call, or a blank user prompt", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          { id: "u1", parent: "root", role: "user", content: text("") },
          {
            id: "c1",
            parent: "u1",
            content: text(""),
            metadata: { command: "search", args: { q: "x" } },
          },
          { id: "a1", parent: "c1", content: text("answer") },
        ],
        "a1",
      ),
    );
    expect(Object.keys(chat.messages).sort()).toEqual(["a1", "c1", "u1"]);
    expect(chat.messages.a1.parentId).toBe("c1");
  });

  it("falls back to a root when the current node was blank all the way up", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          { id: "u1", parent: "root", role: "user", content: text("hi") },
          { id: "b1", parent: "u1", content: text("") },
        ],
        "b1",
      ),
    );
    expect(chat.currentId).toBe("u1");
    expect(findingCodes(chat).filter((c) => c.startsWith("tree."))).toEqual([]);
  });
});

describe("ChatGPT browsing display (HVN-147)", () => {
  it("renders tether_browsing_display as a summary and a result, not as JSON", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          { id: "u1", parent: "root", role: "user", content: text("hi") },
          {
            id: "d1",
            parent: "u1",
            content: {
              content_type: "tether_browsing_display",
              summary: "Looked at a page",
              result: "A line of the page",
            },
          },
        ],
        "d1",
      ),
    );
    expect(responseParts(chat.messages.d1)).toEqual([
      { part_kind: "text", content: "Browse summary: Looked at a page" },
      { part_kind: "text", content: "Browse result: A line of the page" },
    ]);
  });
});
