import { describe, expect, it } from "vitest";
import {
  chatIdFromHref,
  chatIdsFromLinks,
  LIBRARY_SELECTORS,
  waitForLibraryRows,
} from "../src/providers/aistudio/library";

// HVN-117. The repository has no DOM test environment, so the pieces that need none are pinned
// here: the id in a library link and the wait for rows, driven by a fake clock. That the selectors
// match the live page is proven only by a run against it (`haevn health`).

const link = (href: string | null) => ({
  getAttribute: (name: string) => (name === "href" ? href : null),
});

describe("aistudio library: chat ids", () => {
  it("reads the id from a relative or absolute prompt link", () => {
    expect(chatIdFromHref("/prompts/1AbC-xyz_9")).toBe("1AbC-xyz_9");
    expect(chatIdFromHref("https://aistudio.google.com/prompts/1AbC-xyz_9")).toBe("1AbC-xyz_9");
    expect(chatIdFromHref("/prompts/1AbC-xyz_9?model=x#top")).toBe("1AbC-xyz_9");
  });

  it("reads no id from a link that is not a prompt", () => {
    expect(chatIdFromHref(null)).toBeNull();
    expect(chatIdFromHref("")).toBeNull();
    expect(chatIdFromHref("/library")).toBeNull();
    expect(chatIdFromHref("/prompts/")).toBeNull();
  });

  it("collects unique ids in page order and skips links without one", () => {
    const ids = chatIdsFromLinks([
      link("/prompts/aaa"),
      link(null),
      link("/prompts/bbb"),
      link("/prompts/aaa"), // a second link to the same row
      link("/library"),
    ]);
    expect(ids).toEqual(["aaa", "bbb"]);
  });

  it("scopes the link selector to a table row", () => {
    expect(LIBRARY_SELECTORS.chatLink.startsWith(`${LIBRARY_SELECTORS.row} `)).toBe(true);
    expect(LIBRARY_SELECTORS.scrollContainer).not.toBe(LIBRARY_SELECTORS.tableWrapper);
  });
});

/** A fake clock: sleeping advances it, so a ten-second wait takes no time. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    at: () => t,
  };
}

describe("aistudio library: waiting for rows", () => {
  it("returns at once when the rows are there", async () => {
    const c = clock();
    const state = await waitForLibraryRows(
      { rowCount: () => 3, tableRendered: () => true },
      { now: c.now, sleep: c.sleep },
    );
    expect(state).toBe("rows");
    expect(c.at()).toBe(0);
  });

  it("waits through the render race: the table first, the rows later", async () => {
    const c = clock();
    const state = await waitForLibraryRows(
      {
        rowCount: () => (c.at() >= 1500 ? 12 : 0),
        tableRendered: () => c.at() >= 1000,
      },
      { now: c.now, sleep: c.sleep },
    );
    expect(state).toBe("rows");
    expect(c.at()).toBe(1500);
  });

  it("calls a table with no rows after the limit an empty library", async () => {
    const c = clock();
    const state = await waitForLibraryRows(
      { rowCount: () => 0, tableRendered: () => c.at() >= 1000 },
      { now: c.now, sleep: c.sleep, timeoutMs: 10_000 },
    );
    expect(state).toBe("empty");
    expect(c.at()).toBe(10_000);
  });

  it("calls a page with no table after the limit never rendered, not empty", async () => {
    const c = clock();
    const state = await waitForLibraryRows(
      { rowCount: () => 0, tableRendered: () => false },
      { now: c.now, sleep: c.sleep, timeoutMs: 10_000 },
    );
    expect(state).toBe("never-rendered");
    expect(c.at()).toBe(10_000);
  });

  it("finds rows that land in the last poll before the limit", async () => {
    const c = clock();
    const state = await waitForLibraryRows(
      { rowCount: () => (c.at() >= 9750 ? 1 : 0), tableRendered: () => true },
      { now: c.now, sleep: c.sleep, timeoutMs: 10_000, pollMs: 250 },
    );
    expect(state).toBe("rows");
  });
});
