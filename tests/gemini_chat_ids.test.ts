import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGeminiChatIds, geminiChatIdOf } from "../src/providers/gemini/extractor";
import { log } from "../src/utils/logger";

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

// The list RPC (HVN-16). Gemini removed the sidebar list; the extractor now posts the MaZiqc
// batchexecute call that filled it, as ohm measured it live (HVN-16 comment 6). Everything below is
// synthetic: ids, tokens and entry shapes only, no real titles.

const AT_TOKEN = "SYNTHETIC-AT-TOKEN-0000000000000000000000";

/** A synthetic chat id of 16 characters from a number: 0 is "c_" and "0000000000000000". */
function chatId(n: number): string {
  return `c_${n.toString(16).padStart(16, "0")}`;
}

/** One entry of a page: 22 slots, the id first, a title, then the rest null. */
function listEntry(id: string): unknown[] {
  const entry: unknown[] = new Array(22).fill(null);
  entry[0] = id;
  entry[1] = "synthetic title";
  entry[5] = [1700000000, 0];
  entry[9] = 1;
  return entry;
}

/** A batchexecute response around an inner payload, chunk-framed the way Gemini frames it. */
function frame(inner: string): string {
  const first = JSON.stringify([
    ["wrb.fr", "MaZiqc", inner, null, null, null, "generic"],
    ["di", 12],
    ["af.httprm", 11, "x", 1],
  ]);
  const second = JSON.stringify([["e", 4, null, null, 120]]);
  return `)]}'\n\n${first.length}\n${first}\n${second.length}\n${second}`;
}

/** The response of one page of the list. */
function page(ids: string[], nextToken: string | null): string {
  return frame(JSON.stringify([null, nextToken, ids.map(listEntry)]));
}

interface Posted {
  url: string;
  init: RequestInit;
  form: URLSearchParams;
  /** The RPC's own payload: [count, token, flags]. */
  rpc: [number, string | null, unknown];
}

/**
 * Stub the page and its network: a document whose inline scripts are these, a rail of these chat
 * ids, and a fetch that answers each call with the next response (a string is a 200, a number is
 * that status). Returns what was posted.
 */
function stubGemini(options: {
  scripts?: string[];
  rail?: string[];
  responses: (string | number)[] | ((call: number) => string | number);
}): Posted[] {
  const scripts = options.scripts ?? [`window.WIZ_global_data = {"SNlM0e":"${AT_TOKEN}"};`];
  const rail = options.rail ?? [];
  vi.stubGlobal("document", {
    scripts: scripts.map((textContent) => ({ textContent })),
    querySelectorAll: (selector: string) =>
      selector === '[data-test-id="conversation"][data-conversation-id]'
        ? rail.map((id) => sidebarEntry({ "data-conversation-id": id }))
        : [],
  });
  const posted: Posted[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const form = new URLSearchParams(String(init.body));
      const call = posted.length;
      posted.push({
        url,
        init,
        form,
        rpc: JSON.parse(JSON.parse(form.get("f.req") ?? "null")[0][0][1]),
      });
      const next =
        typeof options.responses === "function" ? options.responses(call) : options.responses[call];
      if (typeof next === "number") return new Response("error", { status: next });
      return new Response(next, { status: 200 });
    }),
  );
  return posted;
}

async function failureOf(run: Promise<unknown>): Promise<Error> {
  const err = await run.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

describe("extractGeminiChatIds lists chats through the list RPC (HVN-16)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("follows the token across two pages, keeps the order and asks for 100 a page", async () => {
    const posted = stubGemini({
      responses: [
        page([chatId(1), chatId(2), chatId(3)], "TOKEN-1"),
        page([chatId(4), chatId(5)], null),
      ],
    });

    await expect(extractGeminiChatIds()).resolves.toEqual([
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
      "0000000000000004",
      "0000000000000005",
    ]);

    expect(posted).toHaveLength(2);
    expect(posted[0].rpc).toEqual([100, null, [0, null, 1]]);
    expect(posted[1].rpc).toEqual([100, "TOKEN-1", [0, null, 1]]);
    expect(posted[0].url).toContain("rpcids=MaZiqc");
    expect(posted[0].init.method).toBe("POST");
    expect(posted[0].init.credentials).toBe("include");
    expect(posted[0].init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    });
    expect(posted[0].form.get("at")).toBe(AT_TOKEN);
  });

  it("treats an empty token like the last page", async () => {
    const posted = stubGemini({ responses: [page([chatId(1)], ""), page([chatId(2)], null)] });
    await expect(extractGeminiChatIds()).resolves.toEqual(["0000000000000001"]);
    expect(posted).toHaveLength(1);
  });

  it("lists an account with no chats as empty", async () => {
    stubGemini({ responses: [frame(JSON.stringify([null, null, null]))] });
    await expect(extractGeminiChatIds()).resolves.toEqual([]);
  });

  it("drops a chat that repeats across pages, keeping its first place", async () => {
    stubGemini({
      responses: [
        page([chatId(1), chatId(2)], "TOKEN-1"),
        page([chatId(2), chatId(3), chatId(3)], null),
      ],
    });
    await expect(extractGeminiChatIds()).resolves.toEqual([
      "0000000000000001",
      "0000000000000002",
      "0000000000000003",
    ]);
  });

  it("stops at 50 pages with a warning, and returns what it has", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const posted = stubGemini({
      responses: (call) => page([chatId(call + 1)], `TOKEN-${call + 1}`),
    });

    const ids = await extractGeminiChatIds();

    expect(posted).toHaveLength(50);
    expect(ids).toHaveLength(50);
    expect(ids[0]).toBe("0000000000000001");
    expect(warn.mock.calls.some(([message]) => /more than 50 pages/.test(String(message)))).toBe(
      true,
    );
  });

  it("reads the request token from the page's inline scripts", async () => {
    const posted = stubGemini({
      scripts: [
        "console.log('no token here');",
        `var a=1;window.WIZ_global_data={"nQyAE":{},"SNlM0e":"${AT_TOKEN}","oPEP7c":"x"};`,
      ],
      responses: [page([chatId(1)], null)],
    });
    await extractGeminiChatIds();
    expect(posted[0].form.get("at")).toBe(AT_TOKEN);
  });

  it("throws when the request token is not in the page, before any request", async () => {
    const posted = stubGemini({
      scripts: ["console.log('no token here');"],
      responses: [page([chatId(1)], null)],
    });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/SNlM0e/);
    expect(posted).toHaveLength(0);
  });

  it("throws on a response that is not OK, rather than returning a short list", async () => {
    stubGemini({ responses: [400] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/list request failed: 400/);
  });

  it("throws when a later page fails, rather than returning the first page", async () => {
    stubGemini({ responses: [page([chatId(1)], "TOKEN-1"), 400] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/list request failed: 400/);
  });

  it("throws when the response has no list envelope", async () => {
    const other = JSON.stringify([["wrb.fr", "OtherRpc", "[]", null]]);
    stubGemini({ responses: [`)]}'\n\n${other.length}\n${other}`] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/no list envelope/);
  });

  it("throws when the envelope's JSON cannot be parsed", async () => {
    stubGemini({ responses: [frame("[null, null, [[")] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/does not hold JSON/);
  });

  it("throws when the list is not the shape [null, token, entries]", async () => {
    stubGemini({ responses: [frame(JSON.stringify([null, null, { a: 1 }]))] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/not \[null, token, entries\]/);
  });

  it("throws when the entries are there and none carries a chat id", async () => {
    stubGemini({ responses: [frame(JSON.stringify([null, null, [[null], ["x"]]]))] });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/2 entries but none carries a chat id/);
  });

  it("throws when the list holds fewer chats than the sidebar shows", async () => {
    stubGemini({
      rail: [chatId(1), chatId(2), chatId(3)],
      responses: [page([chatId(1), chatId(2)], null)],
    });
    const err = await failureOf(extractGeminiChatIds());
    expect(err.message).toMatch(/holds 2 chats but the sidebar shows 3/);
  });

  it("accepts a list that covers the sidebar", async () => {
    stubGemini({
      rail: [chatId(1), chatId(2)],
      responses: [page([chatId(1), chatId(2), chatId(3)], null)],
    });
    await expect(extractGeminiChatIds()).resolves.toHaveLength(3);
  });
});
