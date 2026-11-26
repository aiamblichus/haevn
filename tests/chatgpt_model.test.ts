import { describe, expect, it } from "vitest";
import type { ChatMessage, ModelResponse } from "../src/model/haevn_model";
import type {
  ChatGPTRawExtraction,
  OpenAIConversation,
  OpenAIConversationNode,
} from "../src/providers/chatgpt/model";
import { transformOpenAIToHaevn } from "../src/providers/chatgpt/transformer";

// HVN-168: `model:` found no ChatGPT chat by its model, because the transformer wrote the provider's
// name where the model's was. The shapes here are invented text on the fields the site really sends.

interface Spec {
  id: string;
  parent: string;
  role: "user" | "assistant" | "tool";
  metadata?: Record<string, unknown>;
  content?: Record<string, unknown>;
}

function raw(specs: Spec[], conversationDefault?: string | null): ChatGPTRawExtraction {
  const mapping: Record<string, unknown> = {
    root: { id: "root", message: null, parent: null, children: [] },
  };
  for (const [i, spec] of specs.entries()) {
    mapping[spec.id] = {
      id: spec.id,
      parent: spec.parent,
      children: [],
      message: {
        id: spec.id,
        author: { role: spec.role },
        create_time: 1_700_000_000 + i,
        update_time: 1_700_000_000 + i,
        content: spec.content ?? { content_type: "text", parts: ["words"] },
        status: "finished_successfully",
        end_turn: true,
        weight: 1,
        metadata: spec.metadata ?? {},
        recipient: "all",
        channel: null,
      },
    };
  }
  for (const spec of specs) {
    (mapping[spec.parent] as { children: string[] }).children.push(spec.id);
  }
  const conversation = {
    id: "chat-1",
    conversation_id: "chat-1",
    title: "A chat",
    create_time: 1_700_000_000,
    update_time: 1_700_000_100,
    current_node: specs[specs.length - 1].id,
    default_model_slug: conversationDefault ?? null,
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

const user = (id: string, parent: string): Spec => ({ id, parent, role: "user" });
const answer = (id: string, parent: string, metadata?: Record<string, unknown>): Spec => ({
  id,
  parent,
  role: "assistant",
  metadata,
});

function responseOf(message: ChatMessage): ModelResponse {
  return message.message.find((m) => m.kind === "response") as ModelResponse;
}

describe("the model a ChatGPT chat names (HVN-168)", () => {
  it("writes the slug each answer was made with, and lists each slug once", () => {
    const chat = transformOpenAIToHaevn(
      raw([
        user("u1", "root"),
        answer("a1", "u1", { model_slug: "gpt-4o" }),
        user("u2", "a1"),
        answer("a2", "u2", { model_slug: "gpt-4o-mini" }),
        user("u3", "a2"),
        answer("a3", "u3", { model_slug: "gpt-4o" }),
      ]),
    );

    expect(chat.messages.a1.model).toBe("gpt-4o");
    expect(chat.messages.a2.model).toBe("gpt-4o-mini");
    expect(chat.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("keeps the display name in model_name, and no model on what the user or a tool says", () => {
    const chat = transformOpenAIToHaevn(
      raw([
        user("u1", "root"),
        answer("a1", "u1", { model_slug: "gpt-4o" }),
        { id: "t1", parent: "a1", role: "tool", metadata: { model_slug: "gpt-4o" } },
      ]),
    );

    expect(responseOf(chat.messages.a1).model_name).toBe("GPT-4o");
    expect(chat.messages.u1.model).toBe("");
    expect(chat.messages.t1.model).toBe("");
  });

  it("falls back from the answer's slug to its default slug, then to the conversation's", () => {
    const chat = transformOpenAIToHaevn(
      raw(
        [
          user("u1", "root"),
          answer("a1", "u1", { model_slug: "o3", default_model_slug: "gpt-4o" }),
          user("u2", "a1"),
          answer("a2", "u2", { default_model_slug: "gpt-4-turbo" }),
          user("u3", "a2"),
          answer("a3", "u3"),
        ],
        "gpt-5",
      ),
    );

    expect([chat.messages.a1.model, chat.messages.a2.model, chat.messages.a3.model]).toEqual([
      "o3",
      "gpt-4-turbo",
      "gpt-5",
    ]);
    expect(chat.models).toEqual(["o3", "gpt-4-turbo", "gpt-5"]);
  });

  it("names the provider only when its data names no model", () => {
    const chat = transformOpenAIToHaevn(
      raw([user("u1", "root"), answer("a1", "u1", { model_slug: "  " })]),
    );

    expect(chat.messages.a1.model).toBe("");
    expect(chat.models).toEqual(["ChatGPT"]);
  });
});
