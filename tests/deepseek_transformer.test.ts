import { describe, expect, it } from "vitest";
import type { CodeExecutionPart, ModelResponse } from "../src/model/haevn_model";
import type { DeepseekConversationData } from "../src/providers/deepseek/model";
import { transformDeepseekToHaevn } from "../src/providers/deepseek/transformer";

describe("deepseek_transformer", () => {
  it("maps thinking and code blocks into response parts", async () => {
    const data: DeepseekConversationData = {
      sourceId: "deepseek-1",
      title: "DeepSeek Chat",
      url: "https://chat.deepseek.com/a/chat/s/deepseek-1",
      extractedAt: "2024-01-01T00:00:00.000Z",
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        {
          role: "assistant",
          content: "Here you go",
          thinking: "Thinking out loud",
          codeBlocks: [
            {
              language: "js",
              code: "console.log('hi');",
            },
          ],
        },
      ],
    };

    const chat = await transformDeepseekToHaevn(data);

    expect(chat.source).toBe("deepseek");
    expect(chat.title).toBe("DeepSeek Chat");
    expect(chat.timestamp).toBe(new Date(data.extractedAt).getTime());

    const messages = Object.values(chat.messages);
    expect(messages).toHaveLength(2);

    const assistant = messages.find(
      (m) => (m.message[0] as ModelResponse).kind === "response",
    ) as (typeof messages)[number];
    const response = assistant.message[0] as ModelResponse;

    const hasThinking = response.parts.some((p) => p.part_kind === "thinking");
    expect(hasThinking).toBe(true);

    const codePart = response.parts.find(
      (p) => p.part_kind === "code-execution",
    ) as CodeExecutionPart;
    expect(codePart).toBeDefined();
    expect(codePart.code).toContain("console.log");
    expect(codePart.language).toBe("js");
  });

  it("falls back to sourceId as currentId when no messages exist", async () => {
    const data: DeepseekConversationData = {
      sourceId: "deepseek-empty",
      title: "Empty Chat",
      url: "https://chat.deepseek.com/a/chat/s/deepseek-empty",
      extractedAt: "2024-02-01T10:00:00.000Z",
      messages: [],
    };

    const chat = await transformDeepseekToHaevn(data);
    expect(chat.currentId).toBe("deepseek-empty");
    expect(Object.keys(chat.messages)).toHaveLength(0);
  });
});
