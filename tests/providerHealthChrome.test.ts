import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chromeHealthDeps } from "../src/background/health/chromeProbe";
import { runProviderHealth } from "../src/background/health/providerHealth";
import { registerAllProviders } from "../src/providers";
import { claudeRaw, sentinels } from "./helpers/healthFixtures";

// The real probe, on a fake `chrome`: the tab calls, the content script's messages and the bulk-sync
// fetch strategy are the production code; only the browser and the content script (the extractor
// seam) are faked. This is what `haevn health` runs in the extension, minus a site.

vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/services/settingsService", () => ({
  getOpenWebUIBaseUrl: vi.fn(async () => null),
}));

const realChrome = (globalThis as { chrome: unknown }).chrome;
const realSetImmediate = globalThis.setImmediate;

interface FakeBrowser {
  created: { url: string; active: boolean }[];
  removed: number[];
  sent: { tabId: number; action: string; chatId?: string; platformName?: string }[];
  tabUrl: string;
  /** what the content script answers, by action; a missing one never answers */
  contentScript: Record<string, (message: Record<string, unknown>) => unknown>;
}

function install(): FakeBrowser {
  const browser: FakeBrowser = {
    created: [],
    removed: [],
    sent: [],
    tabUrl: "https://claude.ai/new",
    contentScript: {},
  };
  let nextId = 40;
  (globalThis as { chrome: unknown }).chrome = {
    ...(realChrome as object),
    runtime: { getManifest: () => ({ version: "1.2.3" }), lastError: null },
    scripting: { executeScript: async () => [] },
    tabs: {
      create: async (props: { url: string; active: boolean }) => {
        browser.created.push({ url: props.url, active: props.active });
        return { id: nextId++ };
      },
      get: async (id: number) => ({ id, status: "complete", url: browser.tabUrl }),
      remove: async (id: number) => {
        browser.removed.push(id);
      },
      sendMessage: async (tabId: number, message: Record<string, unknown>) => {
        const action = message.action as string;
        browser.sent.push({
          tabId,
          action,
          chatId: message.chatId as string | undefined,
          platformName: message.platformName as string | undefined,
        });
        const answer = browser.contentScript[action];
        if (!answer) throw new Error("Could not establish connection. Receiving end does not exist.");
        return answer(message);
      },
    },
  };
  return browser;
}

beforeEach(() => {
  registerAllProviders();
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as { chrome: unknown }).chrome = realChrome;
});

describe("the real probe, on a fake browser", () => {
  it("opens a background tab, asks the content script for the list, fetches two chats, closes the tab", async () => {
    const browser = install();
    const ids = ["c-1", "c-2", "c-3"].map((n) => sentinels(n).id);
    browser.contentScript = {
      ping: () => ({ status: "ready" }),
      getChatIds: () => ({ success: true, chatIds: ids }),
      fetchConversation: (m) => ({
        success: true,
        data: claudeRaw({ ...sentinels("x"), id: m.chatId as string }),
      }),
    };

    const report = await runProviderHealth({ providers: ["claude"] }, chromeHealthDeps());

    expect(report.extensionVersion).toBe("1.2.3");
    expect(report.rows[0]).toMatchObject({
      provider: "claude",
      status: "ok",
      signedIn: true,
      listed: 3,
      checked: 2,
    });
    // a background tab on the provider's list page, as bulk sync opens one
    expect(browser.created).toEqual([{ url: "https://claude.ai/", active: false }]);
    // the content script is asked what bulk sync asks it, and nothing that saves
    expect(browser.sent.map((s) => s.action)).toEqual([
      "ping",
      "getChatIds",
      "fetchConversation",
      "fetchConversation",
    ]);
    expect(browser.sent.filter((s) => s.action === "fetchConversation").map((s) => s.chatId)).toEqual([
      ids[0],
      ids[1],
    ]);
    expect(browser.sent[2].platformName).toBe("claude");
    expect(browser.removed).toEqual([40]);
  });

  it("opens Gemini's tab in the foreground, as bulk sync does", async () => {
    const browser = install();
    browser.contentScript = {
      ping: () => ({ status: "ready" }),
      getChatIds: () => ({ success: true, chatIds: [] }),
    };
    const report = await runProviderHealth({ providers: ["gemini"] }, chromeHealthDeps());
    expect(browser.created).toEqual([{ url: "https://gemini.google.com/app", active: true }]);
    expect(report.rows[0].findings.map((f) => f.code)).toEqual(["list.empty"]);
  });

  it("reports what the content script says when the list fails, closing the tab", async () => {
    const browser = install();
    browser.contentScript = {
      ping: () => ({ status: "ready" }),
      getChatIds: () => ({ success: false, error: "Could not find organizationId" }),
    };
    const report = await runProviderHealth({ providers: ["claude"] }, chromeHealthDeps());
    expect(report.rows[0]).toMatchObject({ status: "not-signed-in", signedIn: false });
    expect(browser.removed).toEqual([40]);
  });

  it("reads the tab's address when the content script never comes up, and closes that tab too", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const browser = install();
    browser.tabUrl = "chrome-error://chromewebdata/";
    // no ping handler: the page is Chrome's error page and no content script runs there
    const run = runProviderHealth({ providers: ["claude"] }, chromeHealthDeps());
    let done = false;
    run.finally(() => {
      done = true;
    });
    while (!done) {
      await new Promise<void>((resolve) => realSetImmediate(resolve));
      await vi.advanceTimersByTimeAsync(250);
    }
    const report = await run;
    expect(report.rows[0]).toMatchObject({ status: "unreachable", findings: [] });
    expect(browser.removed).toEqual([40]);
  });

  it("does not save anything: the only messages are ping, getChatIds and fetchConversation", async () => {
    const browser = install();
    browser.contentScript = {
      ping: () => ({ status: "ready" }),
      getChatIds: () => ({ success: true, chatIds: [sentinels("one").id] }),
      fetchConversation: (m) => ({
        success: true,
        data: claudeRaw({ ...sentinels("x"), id: m.chatId as string }),
      }),
    };
    await runProviderHealth({ providers: ["claude"] }, chromeHealthDeps());
    const allowed = new Set(["ping", "getChatIds", "fetchConversation"]);
    for (const sent of browser.sent) expect(allowed.has(sent.action), sent.action).toBe(true);
  });
});
