import { afterEach, describe, expect, it, vi } from "vitest";
import { logNoResponse } from "../src/utils/noResponse";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../src/utils/logger", () => ({ log: { warn } }));

// The chrome mock from tests/setup.ts has no getContexts; each test gives the runtime its own.
const runtime = (globalThis as unknown as { chrome: { runtime: Record<string, unknown> } }).chrome
  .runtime;

afterEach(() => {
  warn.mockClear();
  runtime.lastError = null;
  delete runtime.getContexts;
});

describe("logNoResponse", () => {
  it("logs the last error and the live contexts, naming the call site", async () => {
    runtime.lastError = { message: "The message port closed before a response was received." };
    const getContexts = vi.fn(async () => [
      { contextType: "POPUP", documentUrl: "chrome-extension://id/popup.html", tabId: 7 },
      { contextType: "TAB", documentUrl: "chrome-extension://id/options.html", tabId: 8 },
    ]);
    runtime.getContexts = getContexts;

    await logNoResponse("options loadChats");

    expect(getContexts).toHaveBeenCalledWith({});
    expect(warn).toHaveBeenCalledWith(
      "[NoResponse] options loadChats: sendMessage resolved with no response",
      {
        lastError: "The message port closed before a response was received.",
        contexts: [
          { contextType: "POPUP", documentUrl: "chrome-extension://id/popup.html" },
          { contextType: "TAB", documentUrl: "chrome-extension://id/options.html" },
        ],
      },
    );
  });

  it("still logs when getContexts is unavailable", async () => {
    await logNoResponse("viewer load");

    expect(warn).toHaveBeenCalledWith(
      "[NoResponse] viewer load: sendMessage resolved with no response",
      { lastError: undefined, contexts: expect.stringContaining("getContexts failed") },
    );
  });
});
