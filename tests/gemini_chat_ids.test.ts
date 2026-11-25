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
    stubSidebar(entries);

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

/** A fake document: an expanded sidebar holding these entries, with its scroller unless told otherwise. */
function stubSidebar(entries: Entry[], options: { withScroller?: boolean } = {}): void {
  const scroller = {
    tagName: "INFINITE-SCROLLER",
    className: "",
    id: "",
    scrollHeight: 0,
    clientHeight: 0,
    scrollTop: 0,
    classList: { contains: () => false },
    querySelector: () => entries[0] ?? null,
  };
  vi.stubGlobal("getComputedStyle", () => ({ overflowY: "scroll" }));
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (selector === "infinite-scroller") return options.withScroller === false ? [] : [scroller];
      if (selector === '[data-test-id="conversation"]') return entries;
      return [];
    },
    querySelector: () => null,
  });
}

const OPEN_BUTTON = 'button[aria-label="Open sidebar"]';
const SPARKLE_BUTTON = '[data-test-id="side-nav-sparkle-button"]';
const CLOSE_BUTTON = 'button[aria-label="Close sidebar"]';

/**
 * A fake Gemini sidebar that behaves as ohm measured it live (HVN-16): collapsed, the scroller is
 * overflow hidden with class disable-scroll and scrolling it loads nothing; expanded, each scroll to
 * the bottom loads another page. The sparkle button reads "Gemini - new chat" in both states (read
 * live 2026-11-25), so it is never an opener; the toggle reads "Close sidebar" expanded. Ids are
 * synthetic.
 */
function stubGeminiSidebar(options: {
  expanded: boolean;
  total?: number;
  pageSize?: number;
  /** Open sidebar is clicked and nothing changes. */
  neverExpands?: boolean;
}) {
  const total = options.total ?? 50;
  const pageSize = options.pageSize ?? 20;
  const first = 7;
  const all = Array.from({ length: total }, (_, i) => {
    const id = i.toString(16).padStart(16, "0");
    return sidebarEntry({ "data-conversation-id": `c_${id}` }, `/app/${id}`);
  });
  const state = {
    expanded: options.expanded,
    loaded: first,
    openClicks: 0,
    closeClicks: 0,
    newChatClicks: 0,
    scrollsWhileCollapsed: 0,
  };
  const open = {
    click: () => {
      state.openClicks++;
      if (!options.neverExpands) state.expanded = true;
    },
  };
  const close = {
    click: () => {
      state.closeClicks++;
      state.expanded = false;
    },
  };
  const newChat = { click: () => state.newChatClicks++ };
  const scroller = {
    tagName: "INFINITE-SCROLLER",
    className: "",
    id: "",
    clientHeight: 500,
    classList: { contains: (name: string) => name === "disable-scroll" && !state.expanded },
    querySelector: () => all[0],
    get scrollHeight() {
      return state.expanded ? 100 + state.loaded * 50 : 500;
    },
    get scrollTop() {
      return 0;
    },
    set scrollTop(_value: number) {
      if (!state.expanded) {
        state.scrollsWhileCollapsed++;
        return;
      }
      state.loaded = Math.min(total, state.loaded + pageSize);
    },
  };
  vi.stubGlobal("getComputedStyle", () => ({ overflowY: state.expanded ? "scroll" : "hidden" }));
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (selector === "infinite-scroller") return [scroller];
      if (selector === '[data-test-id="conversation"]') return all.slice(0, state.loaded);
      if (selector === OPEN_BUTTON) return !state.expanded || options.neverExpands ? [open] : [];
      if (selector === SPARKLE_BUTTON) return [newChat];
      if (selector === CLOSE_BUTTON) return state.expanded || options.neverExpands ? [close] : [];
      return [];
    },
    querySelector: () => null,
  });
  return { state, total };
}

async function runExtraction() {
  vi.useFakeTimers();
  const outcome = extractGeminiChatIds().then(
    (ids) => ({ ids, err: null as Error | null }),
    (err: unknown) => ({ ids: null as string[] | null, err: err as Error }),
  );
  await vi.runAllTimersAsync();
  return outcome;
}

describe("extractGeminiChatIds opens a collapsed sidebar (HVN-16)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists every page once the sidebar is opened, not only the first", async () => {
    const { state, total } = stubGeminiSidebar({ expanded: false });
    const { ids, err } = await runExtraction();
    expect(err).toBeNull();
    expect(ids).toHaveLength(total);
    expect(new Set(ids).size).toBe(total);
    expect(state.scrollsWhileCollapsed).toBe(0);
  });

  it("clicks Open sidebar once, then Close sidebar once, and leaves it collapsed", async () => {
    const { state } = stubGeminiSidebar({ expanded: false });
    await runExtraction();
    expect(state.openClicks).toBe(1);
    expect(state.closeClicks).toBe(1);
    expect(state.expanded).toBe(false);
    expect(state.newChatClicks).toBe(0);
  });

  it("clicks nothing when the sidebar is already expanded, and still lists every page", async () => {
    const { state, total } = stubGeminiSidebar({ expanded: true });
    const { ids, err } = await runExtraction();
    expect(err).toBeNull();
    expect(ids).toHaveLength(total);
    expect(state.openClicks).toBe(0);
    expect(state.closeClicks).toBe(0);
    expect(state.newChatClicks).toBe(0);
    expect(state.expanded).toBe(true);
  });

  it("throws when the sidebar never becomes scrollable, rather than returning the first page", async () => {
    const { state } = stubGeminiSidebar({ expanded: false, neverExpands: true });
    const { ids, err } = await runExtraction();
    expect(ids).toBeNull();
    expect(err?.message).toMatch(/did not become scrollable/);
    expect(state.openClicks).toBe(1);
  });

  it("still clicks Close sidebar when it opened the sidebar and then threw", async () => {
    const { state } = stubGeminiSidebar({ expanded: false, neverExpands: true });
    await runExtraction();
    expect(state.closeClicks).toBe(1);
  });

  it("opens the sidebar when its scroller has no room to scroll and an Open button is there", async () => {
    // Gemini may mark the collapsed rail some other way than overflow hidden: no room to scroll
    // while entries show, with the Open button on the page, is the same sign.
    const entries = [sidebarEntry({ "data-conversation-id": "c_0123456789abcdef" })];
    let openClicks = 0;
    let closeClicks = 0;
    const scroller = {
      tagName: "INFINITE-SCROLLER",
      className: "",
      id: "",
      scrollHeight: 500,
      clientHeight: 500,
      scrollTop: 0,
      classList: { contains: () => false },
      querySelector: () => entries[0],
    };
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "auto" }));
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) => {
        if (selector === "infinite-scroller") return [scroller];
        if (selector === '[data-test-id="conversation"]') return entries;
        if (selector === OPEN_BUTTON) return [{ click: () => openClicks++ }];
        if (selector === CLOSE_BUTTON) return [{ click: () => closeClicks++ }];
        return [];
      },
      querySelector: () => null,
    });
    const { ids, err } = await runExtraction();
    expect(err).toBeNull();
    expect(ids).toEqual(["0123456789abcdef"]);
    expect(openClicks).toBe(1);
    expect(closeClicks).toBe(1);
  });

  it("throws when the sidebar is collapsed and there is no Open button, and clicks nothing", async () => {
    const { state } = stubGeminiSidebar({ expanded: false });
    const doc = document.querySelectorAll.bind(document);
    vi.stubGlobal("document", {
      querySelectorAll: (selector: string) =>
        selector === OPEN_BUTTON || selector === SPARKLE_BUTTON ? [] : doc(selector),
      querySelector: () => null,
    });
    const { ids, err } = await runExtraction();
    expect(ids).toBeNull();
    expect(err?.message).toMatch(/Open sidebar button was not found/);
    expect(state.openClicks).toBe(0);
    expect(state.closeClicks).toBe(0);
  });
});
