import { describe, expect, it } from "vitest";
import type { Chat, ChatMessage, ModelRequest, ModelResponse } from "../src/model/haevn_model";
import { parseSearchQuery } from "../src/services/searchQuery";
import { buildSearchResultsForChat } from "../src/services/searchTextMatch";

function buildChatWithText(text: string): Chat {
  const request: ModelRequest = {
    kind: "request",
    parts: [
      {
        part_kind: "user-prompt",
        content: text,
        timestamp: "2024-01-01T00:00:00.000Z",
      },
    ],
  };

  const response: ModelResponse = {
    kind: "response",
    parts: [
      {
        part_kind: "text",
        content: "Acknowledged.",
      },
    ],
    timestamp: "2024-01-01T00:00:01.000Z",
  };

  const msg: ChatMessage = {
    id: "m1",
    childrenIds: [],
    message: [request, response],
    model: "test-model",
    done: true,
    chatId: "chat-phrase-1",
    timestamp: 1704067200000,
  };

  return {
    id: "chat-phrase-1",
    source: "test",
    sourceId: "src-phrase-1",
    title: "Phrase test",
    models: ["test-model"],
    params: {},
    currentId: "m1",
    messages: { m1: msg },
    tags: [],
    timestamp: 1704067200000,
    files: [],
    lastSyncedTimestamp: 0,
    checksum: "",
    syncStatus: "new",
  };
}

describe("buildSearchResultsForChat", () => {
  it("matches quoted phrases containing stopwords case-insensitively", () => {
    const chat = buildChatWithText("Dear Eliezer, can you review this argument?");
    const parsed = parseSearchQuery('"dear eliezer"');

    const results = buildSearchResultsForChat(chat, parsed);

    expect(results).toHaveLength(1);
    expect(results[0].messageContent).toContain("Dear Eliezer");
    expect(results[0].messageSnippet.toLowerCase()).toContain("{{highlight}}dear{{/highlight}}");
    expect(results[0].messageSnippet.toLowerCase()).toContain("{{highlight}}eliezer{{/highlight}}");
  });

  it("requires the full phrase, not just the surviving non-stopword token", () => {
    const chat = buildChatWithText("Eliezer wrote back, but nobody said hello first.");
    const parsed = parseSearchQuery('"dear eliezer"');

    const results = buildSearchResultsForChat(chat, parsed);

    expect(results).toHaveLength(0);
  });
});
