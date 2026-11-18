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

  it("holds a phrase that sits far into the message, with every word of it marked", () => {
    const filler = "lorem ipsum dolor ".repeat(60);
    const chat = buildChatWithText(`${filler}dear eliezer, hello again ${filler}`);
    const parsed = parseSearchQuery('"dear eliezer"');

    const [result] = buildSearchResultsForChat(chat, parsed, { radius: 30 });

    expect(result.messageSnippet).toContain(
      "{{HIGHLIGHT}}dear{{/HIGHLIGHT}} {{HIGHLIGHT}}eliezer{{/HIGHLIGHT}}",
    );
    expect(result.messageSnippet.startsWith("... ")).toBe(true);
    expect(result.messageSnippet.length).toBeLessThan(160);
  });

  it("shows a second window for a term that recurs far from its first match", () => {
    const filler = "lorem ipsum dolor ".repeat(40);
    const chat = buildChatWithText(`pineapple ${filler}and a second pineapple here`);
    const parsed = parseSearchQuery("pineapple");

    const [result] = buildSearchResultsForChat(chat, parsed, { radius: 20 });

    expect(result.messageSnippet.split(" ... ")).toHaveLength(2);
    expect(
      result.messageSnippet.match(/\{\{HIGHLIGHT\}\}pineapple\{\{\/HIGHLIGHT\}\}/g),
    ).toHaveLength(2);
  });

  it("finds the match in text whose lower case is longer than the text", () => {
    // "İ" lower-cases to two code units, which shifted an index taken from the lower-cased copy.
    const chat = buildChatWithText(`${"İ".repeat(80)} pineapple ${"İ".repeat(80)}`);
    const parsed = parseSearchQuery("pineapple");

    const [result] = buildSearchResultsForChat(chat, parsed, { radius: 20 });

    expect(result.messageSnippet).toContain("{{HIGHLIGHT}}pineapple{{/HIGHLIGHT}}");
  });
});
