import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGeminiConversationData } from "../src/providers/gemini/extractor";
import { log } from "../src/utils/logger";

// HVN-161: the upward preload waited on a loading bar that never comes. Gemini renders the last 10
// turns of a chat when it opens, so a page with fewer than 10 `user-query` elements is complete,
// and for a page with 10 or more the bar shows within about 200 ms of `scrollTop = 0` when older
// turns are left, and not at all when none are. The loop stops after one round without the bar.
//
// What these tests cannot see: real Gemini. The page here is a domino DOM and a scroller whose
// `scrollTop` setter plays the part measured live (bar after 150 ms, 10 more turns after 600 ms).
// They do not see layout, a throttled background tab (timers clamped to about 1 s, which the
// 500 ms bar wait does not survive; not measured), or Gemini changing its page size from 10. The
// live check is a Gemini bulk sync with Overwrite, compared by message count.

function domOf(html: string): Document {
  const req = createRequire(createRequire(import.meta.url).resolve("turndown"));
  const win = req("@mixmark-io/domino").createWindow(html, "https://gemini.google.com/app/abc");
  const list = Object.getPrototypeOf(win.document.body.querySelectorAll("img"));
  list.forEach ??= Array.prototype.forEach;
  list[Symbol.iterator] ??= Array.prototype[Symbol.iterator];
  return win.document;
}

const BAR = "mat-progress-bar mdc-linear-progress--indeterminate";

/** Turn `n` of a chat: a prompt and its answer. */
const turn = (n: number) => `
  <user-query><span class="user-query-container"><div class="query-content">
    <div class="query-text"><p class="query-text-line">Question ${n}</p></div>
  </div></span></user-query>
  <model-response><message-content class="model-response-text"><div class="markdown">
    <p>Answer ${n}.</p>
  </div></message-content></model-response>`;

const turns = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => turn(from + i)).join("");

async function withPage<T>(doc: Document, run: () => Promise<T>): Promise<T> {
  const g = globalThis as Record<string, unknown>;
  const before = ["document", "window", "HTMLElement"].map((k) => [
    k,
    Object.getOwnPropertyDescriptor(g, k),
  ]);
  Object.defineProperty(g, "document", { value: doc, configurable: true, writable: true });
  // the loop asks `instanceof HTMLElement` of the bar it waits on
  Object.defineProperty(g, "HTMLElement", {
    value: (doc.defaultView as unknown as { HTMLElement: unknown }).HTMLElement,
    configurable: true,
    writable: true,
  });
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

interface Run {
  /** Virtual milliseconds the whole extraction took. */
  ms: number;
  /** How many times the preload wrote `scrollTop` (a round of the loop each). */
  scrolls: number;
  questions: string[];
}

/**
 * A chat of `total` turns of which the page shows the last `shown`. Each write of `scrollTop = 0`
 * on the scroller plays Gemini: with turns still above, the bar shows after `barAfterMs` and,
 * `loadMs` later, `page` older turns arrive and the bar goes. `alwaysMore` never runs out.
 */
async function extractChat(opts: {
  total: number;
  shown: number;
  page?: number;
  barAfterMs?: number;
  loadMs?: number;
  alwaysMore?: boolean;
  /** The bar shows and goes, and no turn arrives. */
  nothingArrives?: boolean;
}): Promise<Run> {
  const {
    total,
    shown,
    page = 10,
    barAfterMs = 150,
    loadMs = 450,
    alwaysMore = false,
    nothingArrives = false,
  } = opts;
  const doc = domOf(
    `<body><div data-test-id="chat-history-container">${turns(total - shown + 1, total)}</div></body>`,
  );
  const scroller = doc.querySelector('[data-test-id="chat-history-container"]') as HTMLElement;
  let oldest = total - shown + 1;
  let scrolls = 0;
  Object.defineProperty(scroller, "scrollTop", {
    get: () => 0,
    set: () => {
      scrolls++;
      if (oldest <= 1 && !alwaysMore) return;
      setTimeout(() => {
        const bar = doc.createElement("mat-progress-bar");
        bar.setAttribute("class", BAR);
        doc.body.appendChild(bar);
        setTimeout(() => {
          if (nothingArrives) {
            bar.remove();
            return;
          }
          const n = alwaysMore ? 1 : Math.min(page, oldest - 1);
          const from = alwaysMore ? oldest - 1 : oldest - n;
          const holder = doc.createElement("div");
          holder.innerHTML = turns(from, oldest - 1);
          const first = scroller.firstChild;
          while (holder.firstChild) scroller.insertBefore(holder.firstChild, first);
          oldest = from;
          bar.remove();
        }, loadMs);
      }, barAfterMs);
    },
  });

  return await withPage(doc, async () => {
    const started = Date.now();
    const run = extractGeminiConversationData();
    await vi.runAllTimersAsync();
    const data = await run;
    return {
      ms: Date.now() - started,
      scrolls,
      questions: data.messages
        .filter((m) => m.role === "user")
        .map((m) => String(m.content).replace("Question ", "")),
    };
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

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => String(from + i));

describe("a page with fewer than 10 turns (Gemini shows the last 10 first, so it is complete)", () => {
  it("skips the upward loop: no scroll, no wait", async () => {
    const run = await extractChat({ total: 9, shown: 9 });

    expect(run.scrolls).toBe(0);
    expect(run.ms).toBe(0);
    expect(run.questions).toEqual(range(1, 9));
  });

  it("skips it for a single turn as well", async () => {
    const run = await extractChat({ total: 1, shown: 1 });

    expect(run.scrolls).toBe(0);
    expect(run.ms).toBe(0);
  });
});

describe("a page with 10 turns or more", () => {
  it("runs the loop at exactly 10, and stops after the one round without the bar", async () => {
    // 10 shown, nothing above: no bar comes. Waited: 500 start delay + 50 after the scroll + the
    // 500 ms bar wait (a poll every 50 ms, ending on the first one past 500 ms).
    const run = await extractChat({ total: 10, shown: 10 });

    expect(run.scrolls).toBe(1);
    expect(run.ms).toBeGreaterThanOrEqual(1050);
    expect(run.ms).toBeLessThanOrEqual(1150);
    expect(run.questions).toEqual(range(1, 10));
  });

  it("loads a chat of 24 turns completely, 10 shown first, and stops on the round with no bar", async () => {
    const run = await extractChat({ total: 24, shown: 10 });

    expect(run.questions).toEqual(range(1, 24));
    // rounds: 10 -> 20 (bar), 20 -> 24 (bar), then one without a bar
    expect(run.scrolls).toBe(3);
    // The loop used to need four barless rounds of 1.85 s after the last load, about 7.6 s alone
    expect(run.ms).toBeLessThan(4000);
  });

  it("loads a chat of 14 turns completely", async () => {
    const run = await extractChat({ total: 14, shown: 10 });

    expect(run.questions).toEqual(range(1, 14));
    // rounds: 10 -> 14 (bar), then one without a bar
    expect(run.scrolls).toBe(2);
  });

  it("loads a chat of 45 turns completely, one page of 10 a round", async () => {
    const run = await extractChat({ total: 45, shown: 10 });

    expect(run.questions).toEqual(range(1, 45));
    expect(run.scrolls).toBe(5);
  });

  it("still ends after 40 rounds when the page always has more", async () => {
    const run = await extractChat({ total: 12, shown: 10, alwaysMore: true });

    expect(run.scrolls).toBe(40);
    expect(run.questions.length).toBe(10 + 40);
  });

  it("waits for a bar that is 3 times slower than the 150 to 190 ms measured, and still loads", async () => {
    // A busy tab: the bar comes 520 ms after the scroll. The wait starts 50 ms after the scroll and
    // ends on the first poll past 500 ms, so this is inside it, and past a wait of 400 ms.
    const run = await extractChat({ total: 24, shown: 10, barAfterMs: 520 });

    expect(run.questions).toEqual(range(1, 24));
  });

  it("stops when the bar shows and no turn comes, instead of scrolling on to the cap", async () => {
    const run = await extractChat({ total: 24, shown: 10, nothingArrives: true });

    // round 1 sets the count (10), round 2 sees the same count
    expect(run.scrolls).toBe(2);
    expect(run.questions).toEqual(range(15, 24));
  });
});
