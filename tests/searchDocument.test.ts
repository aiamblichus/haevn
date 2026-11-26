import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage } from "../src/model/haevn_model";
import {
  extractIndexedChat,
  LABEL_IDS,
  labelKindOf,
  MAX_LABELS,
} from "../src/services/searchDocument";

function message(id: string, model: string): ChatMessage {
  return {
    id,
    childrenIds: [],
    chatId: "c",
    model,
    done: true,
    message: [
      { kind: "request", parts: [{ part_kind: "user-prompt", content: `question ${id}` }] },
      { kind: "response", parts: [{ part_kind: "text", content: `answer ${id}` }] },
    ],
  } as ChatMessage;
}

function chatWith(extra: Partial<Chat>): Chat {
  return {
    id: "c",
    source: "test",
    sourceId: "c",
    title: "A chat",
    models: [],
    params: {},
    currentId: "m1",
    messages: { m1: message("m1", "") },
    tags: [],
    timestamp: 1,
    lastSyncedTimestamp: 1,
    checksum: "",
    syncStatus: "synced",
    deleted: 0,
    ...extra,
  } as Chat;
}

describe("the models and tags of an indexed chat (HVN-164)", () => {
  it("takes the chat's models, then any model a message names that the list does not", () => {
    const indexed = extractIndexedChat(
      chatWith({
        models: ["Claude"],
        messages: { m1: message("m1", "claude-sonnet-4"), m2: message("m2", "Claude") },
      }),
    );

    expect(indexed?.models).toEqual(["Claude", "claude-sonnet-4"]);
  });

  it("names each label once, whatever its case, and keeps the first spelling", () => {
    const indexed = extractIndexedChat(
      chatWith({ models: ["GPT-4o", "gpt-4o", " gpt-4o "], tags: ["Poetry", "poetry", "poetry "] }),
    );

    expect(indexed?.models).toEqual(["GPT-4o"]);
    expect(indexed?.tags).toEqual(["Poetry"]);
  });

  it("leaves out what names nothing: blanks, the Markdown importer's placeholder, a value that is no string", () => {
    const indexed = extractIndexedChat(
      chatWith({
        models: ["", "  ", "unknown", "Unknown", "gpt-4o"],
        tags: ["", 7 as unknown as string, "keep"],
      }),
    );

    expect(indexed?.models).toEqual(["gpt-4o"]);
    expect(indexed?.tags).toEqual(["keep"]);
  });

  it("copes with a stored chat that has no list at all", () => {
    const indexed = extractIndexedChat(
      chatWith({ models: undefined, tags: undefined } as unknown as Partial<Chat>),
    );

    expect(indexed).toMatchObject({ models: [], tags: [] });
  });

  it("takes out the characters the index keeps for its marks", () => {
    const indexed = extractIndexedChat(chatWith({ tags: ["a\u0001b\u0002c"] }));

    expect(indexed?.tags).toEqual(["a b c"]);
  });

  it("keeps at most the number of labels the index has rows for", () => {
    const many = Array.from({ length: MAX_LABELS + 20 }, (_, i) => `label${i}`);

    const indexed = extractIndexedChat(chatWith({ models: many, tags: many }));

    expect(indexed?.models).toHaveLength(MAX_LABELS);
    expect(indexed?.tags).toHaveLength(MAX_LABELS);
  });

  it("does not put a label among the messages", () => {
    const indexed = extractIndexedChat(chatWith({ models: ["gpt-4o"], tags: ["poetry"] }));

    expect(indexed?.messages.map((m) => m.text)).toEqual(["question m1", "answer m1"]);
  });

  it("names the ids of the two kinds of label row, and nothing else", () => {
    expect(labelKindOf(LABEL_IDS.model)).toBe("model");
    expect(labelKindOf(LABEL_IDS.tag)).toBe("tag");
    expect(labelKindOf("title")).toBeUndefined();
    expect(labelKindOf("m1")).toBeUndefined();
  });
});

describe("the models a response names (HVN-168)", () => {
  /** A chat as an earlier release stored it: a placeholder in `models`, the real model in the response. */
  function answeredBy(...names: (string | undefined)[]): Chat {
    const messages: Record<string, ChatMessage> = {};
    names.forEach((name, i) => {
      const id = `m${i + 1}`;
      messages[id] = {
        id,
        childrenIds: [],
        chatId: "c",
        model: "ChatGPT",
        done: true,
        message: [
          { kind: "request", parts: [{ part_kind: "user-prompt", content: `question ${id}` }] },
          {
            kind: "response",
            parts: [{ part_kind: "text", content: `answer ${id}` }],
            ...(name === undefined ? {} : { model_name: name }),
          },
        ],
      } as ChatMessage;
    });
    return chatWith({ models: ["ChatGPT"], messages });
  }

  it("indexes the model_name of each response, after the chat's own models", () => {
    const indexed = extractIndexedChat(answeredBy("GPT-4o", "o3"));

    expect(indexed?.models).toEqual(["ChatGPT", "GPT-4o", "o3"]);
  });

  it("names each once, and counts a display name and a slug that read alike as one", () => {
    const indexed = extractIndexedChat(
      answeredBy("GPT-4o Mini", "gpt-4o-mini", "GPT-4o", "GPT-4o", "gpt-4o"),
    );

    expect(indexed?.models).toEqual(["ChatGPT", "GPT-4o Mini", "GPT-4o"]);
  });

  it("keeps two models that differ in where their separators fall as two labels", () => {
    const indexed = extractIndexedChat(answeredBy("gpt-4o", "gpt-4-o", "o1", "o-1"));

    expect(indexed?.models).toEqual(["ChatGPT", "gpt-4o", "gpt-4-o", "o1", "o-1"]);
  });

  it("keeps two labels that differ only in a symbol the index reads as part of a word", () => {
    const indexed = extractIndexedChat(answeredBy("x \u2713", "x \u2717", "x \u2713"));

    expect(indexed?.models).toEqual(["ChatGPT", "x \u2713", "x \u2717"]);
  });

  it("keeps a label that is no model name when the provider wrote it (DALL-E, Deep Research)", () => {
    const indexed = extractIndexedChat(answeredBy("DALL-E", "Deep Research"));

    expect(indexed?.models).toEqual(["ChatGPT", "DALL-E", "Deep Research"]);
  });

  it("leaves out a blank name, an unknown one and a response that names none", () => {
    const indexed = extractIndexedChat(answeredBy("", "  ", "unknown", "Unknown", undefined, "o3"));

    expect(indexed?.models).toEqual(["ChatGPT", "o3"]);
  });

  it("still stops at the cap", () => {
    const names = Array.from({ length: MAX_LABELS + 10 }, (_, i) => `model-${i}`);
    const indexed = extractIndexedChat(answeredBy(...names));

    expect(indexed?.models).toHaveLength(MAX_LABELS);
  });
});
