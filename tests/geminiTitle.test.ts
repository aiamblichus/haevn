import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  capGeminiTitle,
  extractGeminiConversationData,
  extractGeminiConversationTitle,
} from "../src/providers/gemini/extractor";
import { log } from "../src/utils/logger";

// HVN-161: no title selector the reader tried is on today's Gemini page, so every stored title was
// the first 100 characters of the first prompt. The tab's title is the chat's title followed by
// " - Google Gemini" (13 of 13 chats read live, equal to the title in Gemini's own list once the
// suffix is cut), so the reader takes it first and falls to the old chain when it holds only the
// product's name.
//
// What these tests cannot see: the live page. The tab title here is a `<title>` element in a
// domino document, set before the read. They do not see a title that Gemini sets after the
// messages are on the page (not observed; the read happens after the preload, not at the first
// message), a tab that was moved from one chat to another inside the single-page app (the title
// would be the old chat's until Gemini updates it), or a localised suffix (only the English
// " - Google Gemini" was measured).

function domOf(html: string): Document {
  const req = createRequire(createRequire(import.meta.url).resolve("turndown"));
  const win = req("@mixmark-io/domino").createWindow(html, "https://gemini.google.com/app/abc");
  const list = Object.getPrototypeOf(win.document.body.querySelectorAll("img"));
  list.forEach ??= Array.prototype.forEach;
  list[Symbol.iterator] ??= Array.prototype[Symbol.iterator];
  return win.document;
}

const PROMPT = (text: string) => `
  <user-query><span class="user-query-container"><div class="query-content">
    <div class="query-text"><p class="query-text-line">${text}</p></div>
  </div></span></user-query>
  <model-response><message-content class="model-response-text"><div class="markdown">
    <p>Done.</p>
  </div></message-content></model-response>`;

function page(tabTitle: string | null, body: string): Document {
  const head = tabTitle === null ? "" : `<head><title>${tabTitle}</title></head>`;
  return domOf(`<html>${head}<body>${body}</body></html>`);
}

async function withPage<T>(doc: Document, run: () => Promise<T> | T): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const before = ["document", "window"].map((k) => [k, Object.getOwnPropertyDescriptor(g, k)]);
  Object.defineProperty(g, "document", { value: doc, configurable: true, writable: true });
  Object.defineProperty(g, "window", {
    value: {
      location: { hostname: "gemini.google.com", pathname: "/app/abc", href: doc.URL },
    },
    configurable: true,
    writable: true,
  });
  try {
    return await run();
  } finally {
    for (const [k, d] of before as [string, PropertyDescriptor | undefined][]) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

const titleOf = (tabTitle: string | null, body = PROMPT("Make it wider")) =>
  withPage(page(tabTitle, body), () => extractGeminiConversationTitle());

beforeEach(() => {
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the title, from the tab's title", () => {
  it("is the tab's title without the trailing ' - Google Gemini'", async () => {
    expect(await titleOf("Bazel and SCons - Google Gemini")).toBe("Bazel and SCons");
  });

  it("is taken before the prompt, and before an element the old chain reads", async () => {
    const body = `<conversation-actions><span class="conversation-title">From the header</span></conversation-actions>${PROMPT("Make it wider")}`;

    expect(await titleOf("From the tab - Google Gemini", body)).toBe("From the tab");
  });

  // The reader does not collapse: the document's title getter does (the HTML standard; Chrome
  // gives the same, measured). This pins the stored result, and cannot tell the two apart.
  it("stores a title written with runs of whitespace and newlines as single spaces", async () => {
    expect(await titleOf("  Two   words\n here  - Google Gemini")).toBe("Two words here");
  });

  it("cuts the one trailing suffix and keeps a ' - ' inside the title", async () => {
    expect(await titleOf("Plan - B - Google Gemini")).toBe("Plan - B");
  });

  it("keeps a title that does not carry the suffix", async () => {
    expect(await titleOf("Something else")).toBe("Something else");
  });

  it("does not cut the product's name from the middle of a title", async () => {
    expect(await titleOf("Google Gemini tips - Google Gemini")).toBe("Google Gemini tips");
  });

  it("reaches the stored data, and a custom title still wins", async () => {
    await withPage(page("Bazel and SCons - Google Gemini", PROMPT("Make it wider")), async () => {
      expect((await extractGeminiConversationData()).title).toBe("Bazel and SCons");
      expect((await extractGeminiConversationData({ customTitle: "Mine" })).title).toBe("Mine");
    });
  });
});

describe("a tab title that is only the product's name", () => {
  it.each([
    ["Google Gemini"],
    ["Gemini"],
    ["  Google   Gemini "],
    ["Google Gemini - Google Gemini"],
    [""],
  ])("falls through to the first prompt: %j", async (tabTitle) => {
    expect(await titleOf(tabTitle)).toBe("Make it wider");
  });

  it("falls through when the page has no <title> at all", async () => {
    expect(await titleOf(null)).toBe("Make it wider");
  });

  it("falls through to the header title before the prompt, as before", async () => {
    const body = `<conversation-actions><span class="conversation-title">From the header</span></conversation-actions>${PROMPT("Make it wider")}`;

    expect(await titleOf("Google Gemini", body)).toBe("From the header");
  });

  it("falls through to the sidebar entry of this chat, then the selected one", async () => {
    const side = (href: string, title: string) =>
      `<div data-test-id="conversation" href="${href}"><span class="conversation-title">${title}</span></div>`;
    const sidebar = `${side("/app/zzz", "Other chat")}${side("/app/abc", "This chat")}`;

    expect(await titleOf("Google Gemini", sidebar + PROMPT("Make it wider"))).toBe("This chat");

    const selected = `<div data-test-id="conversation" class="selected"><span class="conversation-title">Selected</span></div>`;
    expect(await titleOf("Google Gemini", selected + PROMPT("Make it wider"))).toBe("Selected");
  });

  it("ends in 'Untitled Gemini Conversation' on a page with nothing at all", async () => {
    expect(await titleOf("Google Gemini", "")).toBe("Untitled Gemini Conversation");
  });
});

// ─── The cap ─────────────────────────────────────────────────────────────────────────────────
//
// Gemini's own titles run to thousands of characters (65 of 308 were 200 or more), and the title
// used to be 100 characters of the prompt. The cap is 100, cut on a word boundary when one is in
// the last 20 characters of the cut, with no ellipsis. It lives in one place and every branch of
// the reader goes through it. What these cases cannot see: how a cut title reads in the archive's
// list (a person's judgement), and a word boundary that is not whitespace (a CJK title has none:
// it is cut at 100).

/** `n` characters: the letter, repeated. */
const run = (n: number, ch = "a") => ch.repeat(n);

describe("the cap on the stored title (HVN-161)", () => {
  it("leaves a title of 99 and of exactly 100 characters as it is", () => {
    expect(capGeminiTitle(run(99))).toBe(run(99));
    expect(capGeminiTitle(run(100))).toBe(run(100));
    const hundredWithSpaces = `${run(40)} ${run(40)} ${run(18)}`;
    expect(hundredWithSpaces.length).toBe(100);
    expect(capGeminiTitle(hundredWithSpaces)).toBe(hundredWithSpaces);
  });

  it("cuts a title of 101 characters with no whitespace at 100", () => {
    expect(capGeminiTitle(run(101))).toBe(run(100));
    expect(capGeminiTitle(run(5000))).toBe(run(100));
  });

  it("adds no ellipsis", () => {
    const cut = capGeminiTitle(`${run(60)} ${run(60)}`);
    expect(cut).not.toMatch(/…|\.\.\./);
  });

  it("cuts at the last whitespace when it is among the last 20 characters (index 80 to 99)", () => {
    // whitespace at index 80: the first index that counts
    expect(capGeminiTitle(`${run(80)} ${run(50)}`)).toBe(run(80));
    // at 85, with a word after it that runs past the limit
    expect(capGeminiTitle(`${run(85)} ${run(50)}`)).toBe(run(85));
    // at 99: the cut leaves the 99 characters before it
    expect(capGeminiTitle(`${run(99)} ${run(50)}`)).toBe(run(99));
  });

  it("takes the last whitespace when there are several", () => {
    expect(capGeminiTitle(`${run(82)} ${run(5)} ${run(50)}`)).toBe(`${run(82)} ${run(5)}`);
  });

  it("cuts at the limit when the last whitespace is before index 80", () => {
    expect(capGeminiTitle(`${run(79)} ${run(50)}`)).toBe(`${run(79)} ${run(20)}`);
  });

  it("keeps all 100 characters when the next one is whitespace (the word ends at the limit)", () => {
    expect(capGeminiTitle(`${run(100)} ${run(50)}`)).toBe(run(100));
    // a whitespace inside the window as well: the word at the limit stays whole
    expect(capGeminiTitle(`${run(85)} ${run(14)} ${run(50)}`)).toBe(`${run(85)} ${run(14)}`);
    expect(capGeminiTitle(`${run(85)} ${run(14)}\n${run(50)}`)).toBe(`${run(85)} ${run(14)}`);
  });

  it("counts a tab or a newline as whitespace, and drops a run of it at the cut", () => {
    expect(capGeminiTitle(`${run(90)}\n\t ${run(50)}`)).toBe(run(90));
    expect(capGeminiTitle(`${run(90)}\n${run(50)}`)).toBe(run(90));
    expect(capGeminiTitle(`${run(90)}\t${run(50)}`)).toBe(run(90));
  });

  it("does not leave half of a surrogate pair", () => {
    const cut = capGeminiTitle(`${run(99)}😀${run(5)}`);
    expect(cut).toBe(run(99));
    // a lone surrogate is what makes encodeURIComponent throw
    expect(() => encodeURIComponent(cut)).not.toThrow();
    expect(() => encodeURIComponent(capGeminiTitle(`${run(98)}😀${run(5)}`))).not.toThrow();
  });

  it("is the same cut on every branch of the reader", async () => {
    const long = `${run(85)} ${run(300)}`;
    const cut = run(85);
    const header = (t: string) =>
      `<conversation-actions><span class="conversation-title">${t}</span></conversation-actions>`;
    const side = (t: string) =>
      `<div data-test-id="conversation" href="/app/abc"><span class="conversation-title">${t}</span></div>`;
    const selected = (t: string) =>
      `<div data-test-id="conversation" class="selected"><span class="conversation-title">${t}</span></div>`;

    // the tab's title
    expect(await titleOf(`${long} - Google Gemini`)).toBe(cut);
    // the header, the sidebar entry of this chat, the selected entry (each with a bare tab title)
    expect(await titleOf("Google Gemini", header(long))).toBe(cut);
    expect(await titleOf("Google Gemini", side(long))).toBe(cut);
    expect(await titleOf("Google Gemini", selected(long))).toBe(cut);
    // the first prompt, which used to be a hard cut at 100 and is now a cut on a word
    expect(await titleOf("Google Gemini", PROMPT(long))).toBe(cut);
  });

  it("stores the capped title, and leaves a title that fits alone", async () => {
    await withPage(page(`${run(85)} ${run(300)} - Google Gemini`, PROMPT("Hi")), async () => {
      expect((await extractGeminiConversationData()).title).toBe(run(85));
    });
    expect(await titleOf("A short one - Google Gemini")).toBe("A short one");
  });
});
