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

  it("leaves info unset when Qwen sent none", async () => {
    const chat = await transformQwenToHaevn(chatData([message({ info: null })]));

    expect(chat.messages.m1.info).toBeUndefined();
  });
});
