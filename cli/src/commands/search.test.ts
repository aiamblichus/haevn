import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequestWithMeta } from "../daemon/client.js";
import { runAsTyped } from "../testing/runAsTyped";
import type { SearchResult } from "../types/chat";
import { consola } from "../utils/output";
import searchCommand, { formatSearchResultsText, searchJson } from "./search";

vi.mock("../daemon/client.js", () => ({ daemonRequestWithMeta: vi.fn() }));

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
});

describe("haevn search refuses a negative --limit or --context, either way (HVN-84)", () => {
  beforeEach(() => {
    vi.mocked(daemonRequestWithMeta).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [["react", "--limit", "-1"], '--limit must be a whole number, 1 or more (got "-1").'],
    [["react", "--limit=-1"], '--limit must be a whole number, 1 or more (got "-1").'],
    [["react", "--context", "-5"], '--context must be a whole number, 0 or more (got "-5").'],
    [["react", "-c", "-5"], '--context must be a whole number, 0 or more (got "-5").'],
  ])("%j exits 1 with the message, before it asks the daemon", async (rawArgs, message) => {
    const error = vi.spyOn(consola, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(runAsTyped(searchCommand, rawArgs)).rejects.toThrow("exit 1");

    expect(error).toHaveBeenCalledWith(message);
    expect(daemonRequestWithMeta).not.toHaveBeenCalled();
  });
});

describe("haevn search and a hit on a model or a tag (HVN-164)", () => {
  const tagHit = hit({
    messageId: "haevn:tag",
    messageContent: "poetry",
    messageSnippet: "{{HIGHLIGHT}}poetry{{/HIGHLIGHT}}",
    label: "tag",
  });

  it("says in text that the hit is a tag, and gives it no message ref and no time", () => {
    const out = formatSearchResultsText([tagHit]);

    expect(out).toContain("tag");
    expect(out).toContain("poetry");
    expect(out).not.toContain("asst");
    expect(out).not.toContain("user");
    expect(out).not.toMatch(/\[[0-9a-f]{12}\]/);
  });

  it("still gives a message hit its ref and its role", () => {
    const out = formatSearchResultsText([hit({})]);

    expect(out).toMatch(/\[[0-9a-f]{12}\]/);
    expect(out).toContain("user");
  });

  it("says in JSON which kind of label it is, and gives no messageRef for it", () => {
    const parsed = JSON.parse(
      searchJson([tagHit, hit({})], { includeMetadata: true, hasMore: false }),
    );

    expect(parsed.results[0]).toMatchObject({ label: "tag", messageContent: "poetry" });
    expect(parsed.results[0]).not.toHaveProperty("messageRef");
    expect(parsed.results[1].messageRef).toMatch(/^[0-9a-f]{12}$/);
    expect(parsed.results[1]).not.toHaveProperty("label");
  });
});

describe("haevn search and a chat with a rough date (HVN-163)", () => {
  // A Gemini chat, not a fragment: the label is keyed on the date, not on the source. The times
  // of its messages are made up, so the extension sends the label and no messageTimestamp.
  it("shows the label, not a time and not unknown", () => {
    const out = formatSearchResultsText([
      hit({ source: "gemini", dateLabel: "undated" }),
      hit({ source: "gemini", messageId: "m2", dateLabel: "c. Mar 2024" }),
    ]);

    expect(out).toContain("undated");
    expect(out).toContain("c. Mar 2024");
    expect(out).not.toContain("unknown");
    expect(out).not.toContain("1970");
    expect(out).not.toContain("ago");
  });

  it("keeps the label in JSON, with no message time", () => {
    const parsed = JSON.parse(
      searchJson([hit({ source: "gemini", dateLabel: "2024" })], {
        includeMetadata: true,
        hasMore: false,
      }),
    );

    expect(parsed.results[0]).toMatchObject({ dateLabel: "2024" });
    expect(parsed.results[0]).not.toHaveProperty("messageTimestamp");
  });

  it("still shows a chat with no rough date the time of its message", () => {
    const out = formatSearchResultsText([hit({ messageTimestamp: Date.now() - 3 * 3600_000 })]);

    expect(out).toContain("3h ago");
  });
});
