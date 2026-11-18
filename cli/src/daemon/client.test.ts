import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./config.js", () => ({
  DEFAULT_DAEMON_PORT: 5517,
  loadConfig: () => ({ port: 5517, apiKey: "key" }),
}));

import { daemonRequest, daemonRequestWithMeta } from "./client.js";

function answerWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status })),
  );
}

const SEARCH = { action: "search", query: "zork" } as const;

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the daemon client and the envelope around data (HVN-77)", () => {
  it("returns hasMore from beside `data`, which is still the list", async () => {
    answerWith({ id: "1", success: true, data: [{ chatId: "c1" }], hasMore: true });

    const reply = await daemonRequestWithMeta<{ chatId: string }[]>(SEARCH);

    expect(reply).toEqual({ data: [{ chatId: "c1" }], hasMore: true });
  });

  it("reads the envelope of an extension from before hasMore: no hasMore, and the same data", async () => {
    answerWith({ id: "1", success: true, data: [{ chatId: "c1" }] });

    const reply = await daemonRequestWithMeta<{ chatId: string }[]>(SEARCH);

    expect(reply.data).toEqual([{ chatId: "c1" }]);
    expect(reply.hasMore).toBeUndefined();
  });

  it("leaves daemonRequest answering the data alone, for every other command", async () => {
    answerWith({ id: "1", success: true, data: { chats: [], total: 0, hasMore: false } });

    expect(await daemonRequest(SEARCH)).toEqual({ chats: [], total: 0, hasMore: false });
  });

  it("still throws the extension's sentence for a failure", async () => {
    answerWith(
      { id: "1", success: false, error: "Type a word to search for.", code: "BAD_QUERY" },
      422,
    );

    await expect(daemonRequestWithMeta(SEARCH)).rejects.toThrow("Type a word to search for.");
  });
});
