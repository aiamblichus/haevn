import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGeminiConversationData } from "../src/providers/gemini/extractor";
import { log } from "../src/utils/logger";

// HVN-161: the extraction used to poll `div.conversation-title` for up to 2 s before it read the
// title, with a selector the title reader does not use, so it guarded nothing and cost 2 s per chat.
// The title is read after the messages are collected; what it reads is the reader's business.

function domOf(html: string): Document {
  const req = createRequire(createRequire(import.meta.url).resolve("turndown"));
  const win = req("@mixmark-io/domino").createWindow(html, "https://gemini.google.com/app/abc");
  const list = Object.getPrototypeOf(win.document.body.querySelectorAll("img"));
  list.forEach ??= Array.prototype.forEach;
  list[Symbol.iterator] ??= Array.prototype[Symbol.iterator];
  return win.document;
}

const CHAT = `
  <user-query><span class="user-query-container"><div class="query-content">
    <div class="query-text"><p class="query-text-line">Make it wider</p></div>
  </div></span></user-query>
  <model-response><message-content class="model-response-text"><div class="markdown">
    <p>Done.</p>
  </div></message-content></model-response>`;

async function withPage<T>(doc: Document, run: () => Promise<T>): Promise<T> {
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

/** The title, and how many (virtual) milliseconds the whole extraction took. */
async function extractOn(html: string): Promise<{ title: string; ms: number }> {
  return await withPage(domOf(`<body>${html}</body>`), async () => {
    const started = Date.now();
    const run = extractGeminiConversationData();
    await vi.runAllTimersAsync();
    const data = await run;
    return { title: data.title, ms: Date.now() - started };
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(log, "info").mockImplementation(() => {});
  vi.spyOn(log, "warn").mockImplementation(() => {});
  vi.spyOn(log, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the Gemini extraction and the page's title element (HVN-161)", () => {
  it("is not slower on a page with no `div.conversation-title` than on one with a stable one", async () => {
    const without = await extractOn(CHAT);
    const withStable = await extractOn(`<div class="conversation-title">Stable</div>${CHAT}`);

    expect(without.ms).toBe(withStable.ms);
  });

  it("stores the same title with and without a `div.conversation-title` in the page", async () => {
    const without = await extractOn(CHAT);
    const withElement = await extractOn(`<div class="conversation-title">Other</div>${CHAT}`);

    expect(without.title).toBe("Make it wider");
    expect(withElement.title).toBe(without.title);
  });
});
