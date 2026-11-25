import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractGrokChatIds } from "../src/providers/grok/extractor";
import { log } from "../src/utils/logger";
import { fetchWithTimeout } from "../src/utils/network_utils";

vi.mock("../src/utils/network_utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/utils/network_utils")>()),
  fetchWithTimeout: vi.fn(),
}));

// The chat list is paced at 5 requests a second. These tests count requests, not time, so the
// limiter is a pass-through here.
vi.mock("../src/utils/rateLimit", () => ({
  RateLimiter: class {
    async schedule<T>(fn: () => Promise<T>): Promise<T> {
      return fn();
    }
  },
}));

// Synthetic ids and tokens only: no real conversation id, title or text is written into a test.
const TOKEN_A = "synthetic/token+a==";
const TOKEN_B = "synthetic-token-b";

// Above the page cap of 50: a walk that ignores the cap fails here instead of looping for ever.
const RUNAWAY_REQUESTS = 60;

const fetchMock = vi.mocked(fetchWithTimeout);

function synthId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function answer(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as unknown as Response;
}

function page(ids: number[], nextPageToken?: string): Response {
  return answer({
    conversations: ids.map((n) => ({ conversationId: synthId(n), title: "Synthetic chat" })),
    textSearchMatches: [],
    ...(nextPageToken ? { nextPageToken } : {}),
  });
}

function failure(status: number, statusText: string): Response {
  return { ok: false, status, statusText, json: async () => ({}) } as unknown as Response;
}

function runaway(): never {
  throw new Error("runaway: the chat list walk did not stop");
}

/** Answers each request by the pageToken it carries. The first request carries none. */
function servePages(pages: Record<string, Response>): void {
  fetchMock.mockImplementation(async (url) => {
    if (fetchMock.mock.calls.length > RUNAWAY_REQUESTS) runaway();
    const token = new URL(url).searchParams.get("pageToken") ?? "first";
    const response = pages[token];
    if (!response) throw new Error(`no synthetic page for ${token}`);
    return response;
  });
}

describe("extractGrokChatIds", () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("follows nextPageToken and returns every id once, in server order", async () => {
    servePages({
      first: page([1, 2, 3], TOKEN_A),
      [TOKEN_A]: page([3, 4, 5], TOKEN_B), // 3 comes back on the second page
      [TOKEN_B]: page([6, 7]),
    });

    const ids = await extractGrokChatIds();

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7].map(synthId));
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("sends the previous page's token, URL-encoded, on the next request", async () => {
    servePages({
      first: page([1], TOKEN_A),
      [TOKEN_A]: page([2], TOKEN_B),
      [TOKEN_B]: page([3]),
    });

    await extractGrokChatIds();

    const urls = fetchMock.mock.calls.map(([url]) => url);
    expect(urls[0]).not.toContain("pageToken");
    expect(urls[1]).toContain("&pageToken=synthetic%2Ftoken%2Ba%3D%3D");
    expect(urls[2]).toContain("&pageToken=synthetic-token-b");
  });

  it("stops when the server repeats a token, with a warning", async () => {
    servePages({
      first: page([1], TOKEN_A),
      [TOKEN_A]: page([2], TOKEN_B),
      [TOKEN_B]: page([3], TOKEN_A), // back to a token already followed
    });
    const warn = vi.spyOn(log, "warn");

    const ids = await extractGrokChatIds();

    expect(ids).toEqual([1, 2, 3].map(synthId));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("repeated a page token"));
  });

  it("throws when a later page fails, instead of returning a partial list", async () => {
    servePages({
      first: page([1], TOKEN_A),
      [TOKEN_A]: failure(503, "Service Unavailable"),
    });

    await expect(extractGrokChatIds()).rejects.toThrow("Failed to fetch chat list: 503");
  });

  it("stops at the page cap, with a warning, and returns what it collected", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (fetchMock.mock.calls.length > RUNAWAY_REQUESTS) runaway();
      // Every page holds one new chat and a token of its own, so only the cap can end the walk.
      const served = new URL(url).searchParams.get("pageToken");
      const n = served ? Number(served.slice("synthetic-token-".length)) : 0;
      return page([n + 1], `synthetic-token-${n + 1}`);
    });
    const warn = vi.spyOn(log, "warn");

    const ids = await extractGrokChatIds();

    expect(fetchMock).toHaveBeenCalledTimes(50);
    expect(ids).toEqual(Array.from({ length: 50 }, (_, i) => synthId(i + 1)));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("page cap"));
  });
});
