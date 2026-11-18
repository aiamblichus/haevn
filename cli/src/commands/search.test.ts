import { describe, expect, it } from "vitest";
import type { SearchResult } from "../types/chat";
import { formatSearchResultsText, readSearchResponse, searchJson } from "./search";

function hit(overrides: Partial<SearchResult>): SearchResult {
  return {
    chatId: "chat-A",
    chatTitle: "Platform title",
    source: "claude",
    messageId: "m1",
    messageSnippet: "a matching snippet",
    messageContent: "a matching snippet",
    messageRole: "user",
    ...overrides,
  };
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("haevn search text output", () => {
  it("prints one header per chat, however many of its messages match", () => {
    const out = formatSearchResultsText([
      hit({ chatId: "chat-A", messageId: "m1" }),
      hit({ chatId: "chat-A", messageId: "m2" }),
      hit({ chatId: "chat-B", chatTitle: "Other title", messageId: "m3" }),
    ]);

    expect(countOf(out, "chat-A")).toBe(1);
    expect(countOf(out, "chat-B")).toBe(1);
    expect(out).toContain("3 results");
  });

  it("shows the metadata title and description only when metadata is included", () => {
    const result = hit({
      metaTitle: "Meta title",
      metadata: {
        title: "Meta title",
        description: "Desc text",
        synopsis: "",
        categories: [],
        keywords: [],
        source: "manual",
        updatedAt: 1,
      },
    });

    const withMetadata = formatSearchResultsText([result]);
    expect(withMetadata).toContain("Meta title");
    expect(withMetadata).toContain("Desc text");

    const withoutMetadata = formatSearchResultsText([result], { includeMetadata: false });
    expect(withoutMetadata).toContain("Platform title");
    expect(withoutMetadata).not.toContain("Meta title");
    expect(withoutMetadata).not.toContain("Desc text");
  });
});

describe("haevn search and the chats the limit cut off (HVN-77)", () => {
  it("says in JSON whether more chats matched", () => {
    const results = [hit({})];
    const json = (hasMore: boolean) =>
      JSON.parse(searchJson(results, { includeMetadata: true, hasMore }));

    expect(json(true)).toMatchObject({ total: 1, hasMore: true });
    expect(json(false)).toMatchObject({ total: 1, hasMore: false });
  });

  it("ends the text output with a line about the limit, only when chats were cut off", () => {
    const cut = formatSearchResultsText([hit({})], { hasMore: true });
    const whole = formatSearchResultsText([hit({})], { hasMore: false });

    expect(cut).toContain("More chats match than were returned. Raise --limit");
    expect(whole).not.toContain("More chats match");
    expect(formatSearchResultsText([hit({})])).not.toContain("More chats match");
  });

  it("reads the answer of an extension that sends the results as a list", () => {
    const results = [hit({})];

    expect(readSearchResponse(results)).toEqual({ results, hasMore: false });
    expect(readSearchResponse({ results, hasMore: true })).toEqual({ results, hasMore: true });
  });
});
