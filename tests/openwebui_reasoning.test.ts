import { describe, expect, it } from "vitest";
import type { OpenWebUIMessage, OpenWebUIRawExtraction } from "../src/providers/openwebui/model";
import { transformOpenWebUIToHaevn } from "../src/providers/openwebui/transformer";

// Synthetic messages in the shapes Open WebUI 0.12 returns (HVN-114): reasoning in `output[]`
// with the answer alone in `content`, and a failed generation with `error.content`.

function convert(assistant: Partial<OpenWebUIMessage>) {
  const raw: OpenWebUIRawExtraction = {
    chat: {
      id: "chat-1",
      user_id: "user-1",
      title: "Synthetic",
      updated_at: 1700000100,
      created_at: 1700000000,
      archived: false,
      chat: {
        history: {
          currentId: "a-1",
          messages: {
            "u-1": { role: "user", content: "question", timestamp: 1700000000 },
            "a-1": {
              role: "assistant",
              content: "",
              timestamp: 1700000001,
              parentId: "u-1",
              ...assistant,
            },
          },
        },
      },
    },
  };
  const chat = transformOpenWebUIToHaevn(raw);
  const message = chat.messages["a-1"];
  const response = message.message.find((m) => m.kind === "response");
  return { message, parts: response && response.kind === "response" ? response.parts : [] };
}

const reasoningItem = (extra: Record<string, unknown>) => ({
  type: "reasoning",
  status: "completed",
  ...extra,
});

describe("openwebui transformer: reasoning in output[]", () => {
  it("reads reasoning from content[].text and keeps the answer from content", () => {
    const { parts } = convert({
      content: "the answer",
      output: [
        reasoningItem({ content: [{ type: "output_text", text: "first thought" }] }),
        { type: "message", content: [{ type: "output_text", text: "the answer" }] },
      ],
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking", "text"]);
    expect(parts[0]).toMatchObject({ content: "first thought" });
    expect(parts[1]).toMatchObject({ content: "the answer" });
  });

  it("reads reasoning from reasoning_details[].text, one part per item", () => {
    const { parts } = convert({
      content: "the answer",
      output: [
        reasoningItem({ reasoning_details: [{ text: "thought A" }] }),
        reasoningItem({ reasoning_details: [{ text: "thought B" }] }),
        { type: "message", content: [{ text: "the answer" }] },
      ],
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking", "thinking", "text"]);
    expect(parts.map((p) => p.content)).toEqual(["thought A", "thought B", "the answer"]);
  });

  it("does not add content and reasoning_details of one item together", () => {
    const { parts } = convert({
      content: "the answer",
      output: [
        reasoningItem({
          content: [{ text: "same thought" }],
          reasoning_details: [{ text: "same thought" }],
        }),
      ],
    });
    expect(parts.filter((p) => p.part_kind === "thinking").map((p) => p.content)).toEqual([
      "same thought",
    ]);
  });

  it("does not double the reasoning of a message that carries both forms", () => {
    const { parts } = convert({
      content:
        '<details type="reasoning" done="true" duration="3">\n<summary>Thought for 3 seconds</summary>\n> same thought\n</details>\nthe answer',
      output: [reasoningItem({ content: [{ text: "same thought" }] })],
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking", "text"]);
    expect(parts[0]).toMatchObject({ content: "same thought" });
    // The <details> block is cut out of the answer, not left in it.
    expect(parts[1]).toMatchObject({ content: "the answer" });
  });

  it("still reads an older message that has only a <details> block", () => {
    const { parts } = convert({
      content:
        '<details type="reasoning" done="true">\n<summary>Thought</summary>\n> older thought\n</details>\nthe answer',
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking", "text"]);
    expect(parts[0]).toMatchObject({ content: "older thought" });
    expect(parts[1]).toMatchObject({ content: "the answer" });
  });

  it("keeps the reasoning of an aborted reasoning-only message and adds no empty text", () => {
    const { parts, message } = convert({
      content: "",
      done: true,
      output: [reasoningItem({ status: "incomplete", content: [{ text: "half a thought" }] })],
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["thinking"]);
    expect(message.error).toBeUndefined();
  });

  it("ignores output items that are not reasoning", () => {
    const { parts } = convert({
      content: "the answer",
      output: [
        { type: "function_call", name: "search", arguments: "{}" },
        { type: "message", content: [{ text: "the answer" }] },
      ],
    });
    expect(parts.map((p) => p.part_kind)).toEqual(["text"]);
  });
});

describe("openwebui transformer: failed generations", () => {
  it("keeps error.content as a text part and flags the message", () => {
    const { parts, message } = convert({
      content: "",
      error: { content: "The model is unavailable" },
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ part_kind: "text", content: "The model is unavailable" });
    expect(message.error).toBe(true);
  });

  it("keeps an answer and an error side by side", () => {
    const { parts } = convert({ content: "partial answer", error: { content: "Stream cut" } });
    expect(parts.map((p) => p.content)).toEqual(["partial answer", "Stream cut"]);
  });

  it("stores no empty text placeholder for an empty message", () => {
    const { parts } = convert({ content: "" });
    expect(parts).toEqual([]);
  });

  it("passes done through, and defaults it to true", () => {
    expect(convert({ content: "x", done: false }).message.done).toBe(false);
    expect(convert({ content: "x" }).message.done).toBe(true);
  });
});
