import { describe, expect, it } from "vitest";
import type { QwenChatData, QwenMessage } from "../src/providers/qwen/model";
import { transformQwenToHaevn } from "../src/providers/qwen/transformer";

function message(overrides: Partial<QwenMessage>): QwenMessage {
  return {
    id: "m1",
    role: "assistant",
    content: "Hello",
    chat_type: "t2t",
    parentId: null,
    childrenIds: [],
    timestamp: 1_700_000_000,
    ...overrides,
  };
}

function chatData(messages: QwenMessage[]): QwenChatData {
  return {
    id: "chat-1",
    user_id: "user-1",
    title: "A chat",
    chat: {
      history: {
        messages: Object.fromEntries(messages.map((m) => [m.id, m])),
        currentId: messages[messages.length - 1].id,
        currentResponseIds: [],
      },
      models: ["qwen3-max"],
      messages,
    },
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    chat_type: "t2t",
  };
}

describe("qwen_transformer", () => {
  it("keeps the token counts under the names MessageInfo defines", async () => {
    const chat = await transformQwenToHaevn(
      chatData([
        message({
          info: { input_tokens: 11, output_tokens: 22, total_tokens: 33, openai: true },
        }),
      ]),
    );

    expect(chat.messages.m1.info).toEqual({
      openai: true,
      prompt_tokens: 11,
      completion_tokens: 22,
      total_tokens: 33,
    });
  });

  it("keeps a failed generation's error as a text part, since the content is empty (HVN-115)", async () => {
    const chat = await transformQwenToHaevn(
      chatData([
        message({
          content: "",
          error: { code: "SyntheticCode", details: "Synthetic details of the failure." },
        }),
        message({ id: "m2", content: "", error: { code: "SyntheticOnlyCode" }, parentId: "m1" }),
      ]),
    );

    expect(chat.messages.m1.message[0]).toMatchObject({
      kind: "response",
      parts: [
        {
          part_kind: "text",
          content: "Generation failed (SyntheticCode): Synthetic details of the failure.",
        },
      ],
    });
    expect(chat.messages.m2.message[0]).toMatchObject({
      kind: "response",
      parts: [{ part_kind: "text", content: "Generation failed (SyntheticOnlyCode)" }],
    });
  });

  it("leaves info unset when Qwen sent none", async () => {
    const chat = await transformQwenToHaevn(chatData([message({ info: null })]));

    expect(chat.messages.m1.info).toBeUndefined();
  });

  it("keeps the parent links Qwen sent: a first message sent again is a second root (HVN-150)", async () => {
    const chat = await transformQwenToHaevn(
      chatData([
        message({ id: "m1", role: "user", content: "Hi" }),
        message({ id: "a1", parentId: "m1" }),
        message({ id: "m1b", role: "user", content: "Hi" }),
        message({ id: "a1b", parentId: "m1b" }),
        message({ id: "m2", role: "user", content: "More", parentId: "a1b" }),
      ]),
    );

    const roots = Object.values(chat.messages)
      .filter((m) => !m.parentId)
      .map((m) => m.id)
      .sort();
    expect(roots).toEqual(["m1", "m1b"]);
    expect(chat.messages.m2.parentId).toBe("a1b");
  });
});
