// AI Studio library page (bulk sync and the health check list chats from it).
//
// The page renders late: `load` fires well before the table does, and the table is virtualised
// and lazy-loaded below the first rows. The parts that need no browser (the selectors, the id out
// of a link, the wait for rows) live here so a unit test can pin them; the scrolling stays in the
// extractor.

export const LIBRARY_SELECTORS = {
  /** The table's wrapper. It is not the scroller (HVN-117); it only shows the table has rendered. */
  tableWrapper: ".lib-table-wrapper",
  /** The element that scrolls the table. */
  scrollContainer: ".page-content-wrapper",
  row: "tr.mat-mdc-row",
  /**
   * A link to a prompt inside a row. Matched by its href, which names the chat, rather than by
   * the class of the link (`a.name-btn` became `a.name-link`, and the next rename would break it
   * again). Scoped to a row so the side navigation's own links are not read as library entries.
   */
  chatLink: 'tr.mat-mdc-row a[href*="/prompts/"]',
} as const;

/** The chat id in a library link, `/prompts/{id}` (relative or absolute, with or without a query). */
export function chatIdFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const match = href.match(/\/prompts\/([^/?#]+)/);
  return match?.[1] ?? null;
}

/** The unique chat ids of some links, in page order. Anything without an element's `getAttribute` can be passed. */
export function chatIdsFromLinks(
  links: Iterable<{ getAttribute(name: string): string | null }>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const id = chatIdFromHref(link.getAttribute("href"));
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * What the wait for the library found.
 * - `rows`: at least one row rendered.
 * - `empty`: the table rendered and no row followed within the time limit: an empty library.
 * - `never-rendered`: not even the table appeared, so the page is not the library, or it did not
 *   load, or the site changed; none of these is an empty library.
 */
export type LibraryState = "rows" | "empty" | "never-rendered";

export interface LibraryProbe {
  rowCount(): number;
  tableRendered(): boolean;
}

export interface WaitForLibraryOptions {
  /** Wall-clock limit. A background tab throttles timers, so a count of polls would run long. */
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function waitForLibraryRows(
  probe: LibraryProbe,
  options: WaitForLibraryOptions = {},
): Promise<LibraryState> {
  const {
    timeoutMs = 10_000,
    pollMs = 250,
    now = () => Date.now(),
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = options;

  const deadline = now() + timeoutMs;
  for (;;) {
    if (probe.rowCount() > 0) return "rows";
    if (now() >= deadline) return probe.tableRendered() ? "empty" : "never-rendered";
    await sleep(pollMs);
  }
}
