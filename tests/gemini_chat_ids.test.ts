import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGeminiChatIds, geminiChatIdOf } from "../src/providers/gemini/extractor";

// Sidebar entries in the shape Gemini's /app page has now (HVN-116): the entry carries
// data-conversation-id ("c_" and the id) and holds an <a href="/app/<id>">. No jslog. Ids are synthetic.

type Entry = Pick<Element, "getAttribute" | "querySelector">;

function sidebarEntry(attributes: Record<string, string>, href?: string): Entry {
  return {
    getAttribute: (name: string) => attributes[name] ?? null,
    querySelector: (selector: string) =>
      selector === "a[href]" && href !== undefined
        ? ({ getAttribute: (name: string) => (name === "href" ? href : null) } as Element)
        : null,
  } as unknown as Entry;
}

describe("geminiChatIdOf (HVN-116)", () => {
  it("reads the id from data-conversation-id, without its c_ prefix", () => {
    const entry = sidebarEntry({ "data-conversation-id": "c_0123456789abcdef" });
    expect(geminiChatIdOf(entry)).toBe("0123456789abcdef");
  });

  it("falls back to the id in the /app/<id> link when the attribute is missing", () => {
    const entry = sidebarEntry({}, "/app/fedcba9876543210");
    expect(geminiChatIdOf(entry)).toBe("fedcba9876543210");
  });

  it("falls back to the link when the attribute holds no valid id", () => {
    const entry = sidebarEntry({ "data-conversation-id": "c_x" }, "/app/fedcba9876543210");
    expect(geminiChatIdOf(entry)).toBe("fedcba9876543210");
  });

  it("reads the id from an absolute link, and ignores its query string", () => {
    const entry = sidebarEntry({}, "https://gemini.google.com/app/fedcba9876543210?hl=en");
    expect(geminiChatIdOf(entry)).toBe("fedcba9876543210");
  });

  it("gives null for an entry with neither an attribute nor a link", () => {
    expect(geminiChatIdOf(sidebarEntry({}))).toBeNull();
  });

  it("does not take a link that is not a chat id, such as /app/settings", () => {
    expect(geminiChatIdOf(sidebarEntry({}, "/app/settings"))).toBeNull();
    expect(geminiChatIdOf(sidebarEntry({}, "/app/0123456789abcde"))).toBeNull();
  });

  it("does not read the id from the old jslog attribute", () => {
    const entry = sidebarEntry({
      jslog: 'BardVeMetadataKey:[["c_0123456789abcdef", null, 0]]',
    });
    expect(geminiChatIdOf(entry)).toBeNull();
  });
});

describe("extractGeminiChatIds lists the sidebar (HVN-116)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns the ids of the entries when they carry no jslog", async () => {
    vi.useFakeTimers();
    const entries = [
      sidebarEntry({ "data-conversation-id": "c_0123456789abcdef" }, "/app/0123456789abcdef"),
      sidebarEntry({ "data-conversation-id": "c_fedcba9876543210" }, "/app/fedcba9876543210"),
    ];
    const scroller = {
      tagName: "INFINITE-SCROLLER",
      className: "",
      id: "",
      scrollHeight: 0,
      scrollTop: 0,
      querySelector: () => entries[0],
    };
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) => {
        if (selector === "infinite-scroller") return [scroller];
        if (selector === '[data-test-id="conversation"]') return entries;
        return [];
      },
    });

    const pending = extractGeminiChatIds();
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual(["0123456789abcdef", "fedcba9876543210"]);
  });

  it("throws when the sidebar has entries and none carries an id, rather than returning []", async () => {
    vi.useFakeTimers();
    stubSidebar([sidebarEntry({}), sidebarEntry({ jslog: "c_0123456789abcdef" })]);
    const outcome = extractGeminiChatIds().then(
      () => null,
      (err: unknown) => err,
    );
    await vi.runAllTimersAsync();
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/2 chat entries but none carries a chat id/);
  });

  it("throws when the sidebar's scroll container is missing, rather than returning []", async () => {
    stubSidebar([], { withScroller: false });
    const outcome = extractGeminiChatIds().then(
      () => null,
      (err: unknown) => err,
    );
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/scroll container/);
  });
});

/** A fake document: a sidebar holding these entries, with its scroller unless told otherwise. */
function stubSidebar(entries: Entry[], options: { withScroller?: boolean } = {}): void {
  const scroller = {
    tagName: "INFINITE-SCROLLER",
    className: "",
    id: "",
    scrollHeight: 0,
    scrollTop: 0,
    querySelector: () => entries[0] ?? null,
  };
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (selector === "infinite-scroller") return options.withScroller === false ? [] : [scroller];
      if (selector === '[data-test-id="conversation"]') return entries;
      return [];
    },
    querySelector: () => null,
  });
}
