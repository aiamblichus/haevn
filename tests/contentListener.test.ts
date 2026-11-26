import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HVN-161: content.js is a manifest content script and is injected again by executeScript, always
// into the same isolated world. One request must run one handler however many times it is loaded,
// and a tab whose script was orphaned by an extension reload must still get a working listener.

type Listener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

const LISTENER_KEY = Symbol.for("haevn.content.messageListener");

/** One `chrome` as one extension context sees it: its own listener registry. */
function makeChrome(options: { removeThrows?: boolean } = {}) {
  const listeners: Listener[] = [];
  const chromeStub = {
    runtime: {
      onMessage: {
        addListener: (l: Listener) => {
          listeners.push(l);
        },
        removeListener: (l: Listener) => {
          if (options.removeThrows) throw new Error("Extension context invalidated.");
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      sendMessage: async () => {},
      lastError: null,
    },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  };
  return { chromeStub, listeners };
}

/** Deliver one message the way Chrome does: to every listener of the context. */
function dispatch(listeners: Listener[], message: unknown): unknown[] {
  const responses: unknown[] = [];
  for (const l of [...listeners]) l(message, {}, (r) => responses.push(r));
  return responses;
}

/** One evaluation of the content bundle (the module registry is reset; globalThis is kept). */
async function evaluateContentScript(): Promise<void> {
  vi.resetModules();
  await import("../src/content/content");
}

describe("content script message listener (HVN-161)", () => {
  beforeEach(() => {
    vi.stubGlobal("location", new URL("https://example.invalid/chat/c1"));
    delete (globalThis as Record<symbol, unknown>)[LISTENER_KEY];
  });
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[LISTENER_KEY];
    vi.unstubAllGlobals();
  });

  it("registers one listener on first load, and it answers a ping once", async () => {
    const { chromeStub, listeners } = makeChrome();
    vi.stubGlobal("chrome", chromeStub);
    await evaluateContentScript();
    expect(listeners).toHaveLength(1);
    expect(dispatch(listeners, { action: "ping" })).toEqual([{ status: "ready" }]);
  });

  it("keeps one listener, and one handler run per message, after several injections", async () => {
    const { chromeStub, listeners } = makeChrome();
    vi.stubGlobal("chrome", chromeStub);
    await evaluateContentScript();
    await evaluateContentScript();
    await evaluateContentScript();
    expect(listeners).toHaveLength(1);
    // A request that a handler answers with a platform: one handler run is one response.
    expect(dispatch(listeners, { action: "ping" })).toHaveLength(1);
    expect(dispatch(listeners, { action: "detectPlatform" })).toHaveLength(1);
  });

  it("runs a retried extractData as one extraction, not one per injection", async () => {
    const { chromeStub, listeners } = makeChrome();
    vi.stubGlobal("chrome", chromeStub);
    // The page is one no provider claims: the handler answers with an error, once per handler run.
    // Attempts 1, 2 and 3 each inject content.js again (navigateTabToUrl).
    await evaluateContentScript();
    await evaluateContentScript();
    await evaluateContentScript();
    await evaluateContentScript();
    const answers: unknown[] = [];
    const returned = listeners.map((l) =>
      l({ action: "extractData", chatId: "c1" }, {}, (r) => answers.push(r)),
    );
    // Only the live listener asks for an asynchronous response.
    expect(returned).toEqual([true]);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(answers).toHaveLength(1);
  });

  it("gives a tab a working listener after an extension reload orphaned the old script", async () => {
    // Before the reload: one script, one listener, on the old context's chrome.
    const before = makeChrome();
    vi.stubGlobal("chrome", before.chromeStub);
    await evaluateContentScript();
    expect(before.listeners).toHaveLength(1);

    // The extension reloads. The old listener stays on the dead context (nothing will call it);
    // the module's globals are still in the world. The next injection runs on a new context
    // whose chrome does not know the old listener, and whose removeListener may throw.
    const after = makeChrome({ removeThrows: true });
    vi.stubGlobal("chrome", after.chromeStub);
    await evaluateContentScript();

    expect(after.listeners).toHaveLength(1);
    expect(dispatch(after.listeners, { action: "ping" })).toEqual([{ status: "ready" }]);
  });
});
