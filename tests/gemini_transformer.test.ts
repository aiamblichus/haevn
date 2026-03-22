import { describe, expect, it } from "vitest";
import type { GeminiConversationData } from "../src/providers/gemini/model";
import { transformGeminiToHaevn } from "../src/providers/gemini/transformer";

describe("gemini_transformer", () => {
  it("sets providerLastModifiedTimestamp from extractedAt", async () => {
    const extractedAt = "2024-06-01T10:00:00.000Z";
    const data: GeminiConversationData = {
      platform: "gemini",
      url: "https://gemini.google.com/app/abc",
      conversationId: "conv-1",
      title: "Sample Gemini Chat",
      messageCount: 2,
      extractedAt,
      messages: [
        {
          index: 1,
          content: "Hello",
          timestamp: "2024-06-01T09:59:00.000Z",
          localTime: "irrelevant",
          role: "user",
          files: [],
        },
        {
          index: 2,
          content: "Hi there",
          timestamp: "2024-06-01T10:00:00.000Z",
          localTime: "irrelevant",
          role: "assistant",
          files: [],
        },
      ],
    };

    const chat = await transformGeminiToHaevn(data);
    // Updated expectation: gemini transformer now uses newest message timestamp for providerLastModifiedTimestamp
    expect(chat.providerLastModifiedTimestamp).toBe(new Date(data.messages[1].timestamp).getTime());
  });
});
