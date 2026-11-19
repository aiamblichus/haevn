import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFailure,
  type FetchedChat,
  HealthBusyError,
  type HealthDeps,
  type HealthProbe,
  HealthRequestError,
  isSignInUrl,
  normalizeHealthOptions,
  ProbeOpenError,
  type ProviderHealthReport,
  type ProviderHealthRow,
  runProviderHealth,
  scrubMessage,
} from "../src/background/health/providerHealth";
import {
  acquireOperationLock,
  getActiveOperation,
  releaseOperationLock,
} from "../src/background/state";
import { registerAllProviders } from "../src/providers";
import { getAllProviders, type Provider } from "../src/providers/provider";
import { claudeRaw, RAW_BY_PROVIDER, type Sentinels, sentinels } from "./helpers/healthFixtures";

// The transformers log what they work on (chat ids among it); keep the test output readable.
vi.mock("../src/utils/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// providerHealth is tested at the seam the browser sits behind: a fake probe stands where the tab,
// the content script and the extractor are, and everything on our side of it is real (the
// registry, each provider's own transformer with media skipped, checkChat, the lock).

import { deps, FakeProbe, type Hang, idsFor, type Script, WEB } from "./helpers/healthProbe";

const realSetImmediate = globalThis.setImmediate;

/** Fake the clock and setTimeout only; setImmediate stays real so the loop can yield. */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
}

/** Drive fake timers until the run has settled; a provider's own timer starts only when its turn comes. */
async function untilSettled<T>(run: Promise<T>): Promise<T> {
  let settled = false;
  run.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (!settled) {
    // Real macrotasks first: the transformers hash with crypto.subtle, which answers off the loop.
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => realSetImmediate(resolve));
    await vi.advanceTimersByTimeAsync(250);
  }
  return run;
}

const row = (report: ProviderHealthReport, provider: string): ProviderHealthRow =>
  report.rows.find((r) => r.provider === provider) as ProviderHealthRow;

beforeEach(() => {
  registerAllProviders();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("providerHealth: a healthy world", () => {
  it("reports one ok row per web provider, in registry order, two chats checked each", async () => {
    const probe = new FakeProbe();
    const report = await runProviderHealth({}, deps(probe));

    expect(report.rows.map((r) => r.provider)).toEqual(WEB().map((p) => p.name));
    expect(report.rows).toHaveLength(9);
    for (const r of report.rows) {
      expect(r, r.provider).toMatchObject({
        status: "ok",
        signedIn: true,
        listed: 3,
        checked: 2,
        findings: [],
      });
      expect(r.shapes).toHaveLength(2);
      expect(r.shapes[0].messages).toBeGreaterThanOrEqual(2);
    }
    expect(report.extensionVersion).toBe("9.9.9");
    expect(new Date(report.startedAt).toString()).not.toBe("Invalid Date");
  });

  it("does not report a web provider's importer-only neighbours", async () => {
    const report = await runProviderHealth({}, deps(new FakeProbe()));
    for (const name of ["claudecode", "codex", "pi", "openrouter"]) {
      expect(report.rows.find((r) => r.provider === name)).toBeUndefined();
    }
  });

  it("samples the head of each list: the first two ids, in order, never the third", async () => {
    const probe = new FakeProbe();
    await runProviderHealth({}, deps(probe));
    for (const p of WEB()) {
      const ids = idsFor(p.name);
      expect(probe.fetched.filter((f) => f.provider === p.name).map((f) => f.id)).toEqual([
        ids[0],
        ids[1],
      ]);
    }
  });

  it("takes as many chats as asked, up to five, and no more than the list holds", async () => {
    const probe = new FakeProbe();
    const report = await runProviderHealth({ providers: ["claude"], chats: 5 }, deps(probe));
    expect(row(report, "claude").checked).toBe(3);
    expect(probe.fetched).toHaveLength(3);
  });

  it("checks only the providers named", async () => {
    const probe = new FakeProbe();
    const report = await runProviderHealth({ providers: ["deepseek", "claude"] }, deps(probe));
    expect(report.rows.map((r) => r.provider)).toEqual(["claude", "deepseek"]);
    expect(probe.listed.sort()).toEqual(["claude", "deepseek"]);
  });

  it("opens one tab at a time and closes every tab it opened", async () => {
    const probe = new FakeProbe();
    await runProviderHealth({}, deps(probe));
    expect(probe.opened).toHaveLength(9);
    expect(probe.closed.sort()).toEqual([...probe.opened].sort());
    expect(probe.maxOpen).toBe(1);
  });

  it("runs the providers that need a foreground tab last", async () => {
    const probe = new FakeProbe();
    await runProviderHealth({}, deps(probe));
    const last = probe.listed.slice(-2).sort();
    expect(last).toEqual(["aistudio", "gemini"]);
  });
});

describe("providerHealth: not signed in, and unreachable, are rows", () => {
  const cases: [string, (s: Script) => void][] = [
    ["claude: no organization cookie", (s) => (s.ids = new Error("Could not find organizationId"))],
    [
      "chatgpt: no access token",
      (s) =>
        (s.ids = new Error(
          "Unable to obtain ChatGPT access token. Please ensure you are logged in.",
        )),
    ],
    [
      "grok: a 401 on the list",
      (s) => (s.ids = new Error("Failed to fetch chat list: 401 Unauthorized")),
    ],
    [
      "qwen: a 403 on the list",
      (s) => (s.ids = new Error("Failed to fetch chat list: 403 Forbidden")),
    ],
    [
      "qwen: a signed-out account answers success=false",
      (s) => (s.ids = new Error("API returned success=false for chat list")),
    ],
    [
      "poe: no tokens",
      (s) => (s.ids = new Error("No valid Poe API tokens available. Please refresh the Poe page.")),
    ],
    [
      "deepseek: no token in localStorage",
      (s) => (s.ids = new Error("DeepSeek auth token not found. Please ensure you are logged in.")),
    ],
    [
      "aistudio: sent to Google's sign-in page, where the content script cannot run",
      (s) => {
        s.open = new Error("Content script in tab 5 did not respond to ping.");
        s.tabUrlAfterFailure = "https://accounts.google.com/v3/signin/identifier?continue=x";
      },
    ],
    [
      "claude: the page loads and the tab sits on /login",
      (s) => {
        s.tabUrl = "https://claude.ai/login?returnTo=%2F";
        s.ids = new Error("should not be reached");
      },
    ],
  ];

  for (const [label, change] of cases) {
    it(`${label}`, async () => {
      const name = label.split(":")[0];
      const probe = new FakeProbe();
      probe.script(name, change);
      const report = await runProviderHealth({}, deps(probe));
      expect(row(report, name)).toMatchObject({
        status: "not-signed-in",
        signedIn: false,
        checked: 0,
        findings: [],
      });
      // the other eight are untouched
      expect(report.rows.filter((r) => r.status === "ok")).toHaveLength(8);
      expect(probe.closed.sort()).toEqual([...probe.opened].sort());
    });
  }

  it("says the sign-in page, not the error text, when the tab's address explains the failure", async () => {
    const probe = new FakeProbe();
    probe.script("aistudio", (s) => {
      s.open = new Error("Content script in tab 5 did not respond to ping.");
      s.tabUrlAfterFailure = "https://accounts.google.com/v3/signin/identifier";
    });
    probe.script("gemini", (s) => {
      s.open = new Error("Content script in tab 6 did not respond to ping.");
      s.tabUrlAfterFailure = "chrome-error://chromewebdata/";
    });
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "aistudio").note).toBe("the site sent the tab to a sign-in page");
    expect(row(report, "gemini").note).toBe("the browser could not reach the site");
  });

  it("a sign-in page seen before the list is asked skips the list", async () => {
    const probe = new FakeProbe();
    probe.script("claude", (s) => {
      s.tabUrl = "https://claude.ai/login";
      s.ids = ["x"];
    });
    await runProviderHealth({ providers: ["claude"] }, deps(probe));
    expect(probe.listed).toEqual([]);
  });

  it("reports an unreachable site as unreachable, not as a failure", async () => {
    const probe = new FakeProbe();
    probe.script("gemini", (s) => {
      s.open = new Error("Content script in tab 7 did not respond to ping.");
      s.tabUrlAfterFailure = "chrome-error://chromewebdata/";
    });
    probe.script("poe", (s) => (s.ids = new TypeError("Failed to fetch")));
    probe.script("grok", (s) => (s.open = new Error("Timeout: Tab 9 took too long to load.")));
    const report = await runProviderHealth({}, deps(probe));
    for (const name of ["gemini", "poe", "grok"]) {
      expect(row(report, name), name).toMatchObject({
        status: "unreachable",
        checked: 0,
        findings: [],
      });
    }
    expect(report.rows.filter((r) => r.status === "ok")).toHaveLength(6);
  });

  it("does not take a server error on the list for 'unreachable'", async () => {
    const probe = new FakeProbe();
    probe.script(
      "qwen",
      (s) => (s.ids = new Error("Failed to fetch chat list: 500 Internal Server Error")),
    );
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "qwen").status).toBe("fail");
    expect(row(report, "qwen").findings.map((f) => f.code)).toEqual(["list.failed"]);
  });

  it("does not take a content script that never answers for a sign-in or an outage", async () => {
    const probe = new FakeProbe();
    probe.script("claude", (s) => {
      s.open = new Error("Content script in tab 3 did not respond to ping.");
      s.tabUrlAfterFailure = "https://claude.ai/new";
    });
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "claude").status).toBe("fail");
    expect(row(report, "claude").findings.map((f) => f.code)).toEqual(["open.failed"]);
  });

  it("skips Open WebUI, with its reason, when no address is set", async () => {
    const probe = new FakeProbe();
    const report = await runProviderHealth({}, deps(probe, { openWebUIBaseUrl: async () => null }));
    expect(row(report, "openwebui")).toMatchObject({
      status: "skipped",
      checked: 0,
      note: "no Open WebUI address is set in the settings",
    });
    expect(probe.listed).not.toContain("openwebui");
    expect(report.rows).toHaveLength(9);
  });
});

describe("providerHealth: what each step can find", () => {
  it("an empty list is a warning, not a pass and not a failure", async () => {
    const probe = new FakeProbe();
    probe.script("gemini", (s) => (s.ids = []));
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "gemini")).toMatchObject({
      status: "warn",
      listed: 0,
      checked: 0,
      signedIn: null,
    });
    expect(row(report, "gemini").findings.map((f) => f.code)).toEqual(["list.empty"]);
  });

  it("DeepSeek's 'No DeepSeek chats found' is the same empty list", async () => {
    const probe = new FakeProbe();
    probe.script("deepseek", (s) => (s.ids = new Error("No DeepSeek chats found")));
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "deepseek").findings.map((f) => f.code)).toEqual(["list.empty"]);
  });

  it("a chat that cannot be fetched fails the provider", async () => {
    const probe = new FakeProbe();
    const [first] = idsFor("claude");
    probe.script("claude", (s) => {
      (s.chats as Record<string, FetchedChat>)[first] = { success: false, error: "HTTP 500" };
    });
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "claude")).toMatchObject({ status: "fail", checked: 1 });
    expect(row(report, "claude").findings.map((f) => f.code)).toEqual(["fetch.failed"]);
  });

  it("a payload the transformer chokes on is a transform.threw, with the reason", async () => {
    const probe = new FakeProbe();
    const [first] = idsFor("claude");
    probe.script("claude", (s) => {
      (s.chats as Record<string, FetchedChat>)[first] = { success: true, data: {} };
    });
    const report = await runProviderHealth({}, deps(probe));
    const claude = row(report, "claude");
    expect(claude.status).toBe("fail");
    const codes = claude.findings.map((f) => f.code);
    expect(codes).toContain("transform.threw");
    // Claude's own validator refuses the same payload; the sentence replaces a bare TypeError
    expect(codes).toContain("validate.failed");
    expect(claude.checked).toBe(1);
  });

  it("a chat the transformer lets through broken is caught by the ruler", async () => {
    const probe = new FakeProbe();
    const [first] = idsFor("claude");
    const broken = claudeRaw(sentinels("claude0"));
    // a new site shape: the assistant's text comes back empty, as a selector that matched nothing
    broken.chat_messages[1].text = "";
    probe.script("claude", (s) => {
      (s.chats as Record<string, FetchedChat>)[first] = { success: true, data: broken };
    });
    const report = await runProviderHealth({}, deps(probe));
    const claude = row(report, "claude");
    expect(claude.status).toBe("warn");
    // an empty assistant message has no parts to be empty: the drift shows as a response without
    // text, which the ruler sees as an assistant turn holding nothing
    expect(claude.findings.length).toBeGreaterThan(0);
    expect(claude.checked).toBe(2);
  });

  it("an empty user prompt on a provider that keeps it is a failure", async () => {
    const probe = new FakeProbe();
    const [first] = idsFor("deepseek");
    const raw = RAW_BY_PROVIDER.deepseek(sentinels("deepseek0")) as {
      messages: { content: string }[];
    };
    raw.messages[0].content = "";
    probe.script("deepseek", (s) => {
      (s.chats as Record<string, FetchedChat>)[first] = { success: true, data: raw };
    });
    const report = await runProviderHealth({}, deps(probe));
    const finding = row(report, "deepseek").findings.find((f) => f.code === "text.empty");
    expect(finding).toMatchObject({ level: "fail", count: 1, chats: 1 });
    expect(row(report, "deepseek").status).toBe("fail");
  });

  it("sums a rule's counts over the sampled chats", async () => {
    const probe = new FakeProbe();
    probe.script("deepseek", (s) => {
      for (const [n, id] of idsFor("deepseek").slice(0, 2).entries()) {
        const raw = RAW_BY_PROVIDER.deepseek(sentinels(`deepseek${n}`)) as {
          messages: { content: string }[];
        };
        raw.messages[0].content = "";
        (s.chats as Record<string, FetchedChat>)[id] = { success: true, data: raw };
      }
    });
    const report = await runProviderHealth({}, deps(probe));
    expect(row(report, "deepseek").findings.find((f) => f.code === "text.empty")).toMatchObject({
      count: 2,
      chats: 2,
    });
  });
});

describe("providerHealth: a slow provider gets a time limit", () => {
  it("stops a list that never answers, reports a timeout, and goes on", async () => {
    fakeClock();
    const probe = new FakeProbe();
    probe.script("grok", (s) => (s.ids = "hang"));
    const run = runProviderHealth(
      { timeoutMs: 5_000 },
      deps(probe, { sleep: async () => undefined }),
    );
    const report = await untilSettled(run);

    expect(row(report, "grok")).toMatchObject({ status: "timeout", checked: 0 });
    expect(row(report, "grok").note).toContain("5 s");
    expect(row(report, "grok").note).toContain("listing the chats");
    expect(row(report, "grok").ms).toBeGreaterThanOrEqual(5_000);
    expect(report.rows.filter((r) => r.status === "ok")).toHaveLength(8);
    // its tab is closed all the same
    expect(probe.closed.sort()).toEqual([...probe.opened].sort());
  });

  it("stops in the middle of the sample, and says at which step", async () => {
    fakeClock();
    const probe = new FakeProbe();
    const [first] = idsFor("claude");
    probe.script("claude", (s) => {
      (s.chats as Record<string, FetchedChat | Hang>)[first] = "hang";
    });
    const run = runProviderHealth({ providers: ["claude"], timeoutMs: 5_000 }, deps(probe));
    const report = await untilSettled(run);
    expect(row(report, "claude").status).toBe("timeout");
    expect(row(report, "claude").note).toContain("fetching chat 1");
  });

  it("a provider that wakes up after its limit does no more work", async () => {
    fakeClock();
    const probe = new FakeProbe();
    let release: (ids: string[]) => void = () => undefined;
    probe.listIds = async (tabId: number) => {
      probe.listed.push("claude");
      void tabId;
      return new Promise<string[]>((resolve) => {
        release = resolve;
      });
    };
    const run = runProviderHealth({ providers: ["claude"], timeoutMs: 5_000 }, deps(probe));
    await untilSettled(run);
    release(idsFor("claude"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe.fetched).toEqual([]);
  });

  it("holds the last provider to what is left of the run's time, not to its own full limit", async () => {
    fakeClock();
    const probe = new FakeProbe();
    probe.script("grok", (s) => {
      s.ids = "hang";
    });
    const only = runProviderHealth(
      { providers: ["grok"], timeoutMs: 120_000, totalMs: 7_000 },
      deps(probe),
    );
    const report = await untilSettled(only);
    // its own limit is 120 s but the run's is 7 s (nothing spent yet): it stops at 7, and says 7
    expect(row(report, "grok").status).toBe("timeout");
    expect(row(report, "grok").note).toContain("7 s");
    expect(row(report, "grok").ms).toBeLessThan(9_000);
  });

  it("stops starting providers when the whole run's time is up, and says so in a row", async () => {
    let clock = 0;
    const probe = new FakeProbe();
    const slowOpen = probe.open.bind(probe);
    probe.open = async (url, fg, onTab) => {
      clock += 100_000;
      return slowOpen(url, fg, onTab);
    };
    const report = await runProviderHealth({ totalMs: 5_000 }, deps(probe, { now: () => clock }));
    // the first provider ran and used the budget; the rest are rows that say they did not run
    const skipped = report.rows.filter((r) => r.status === "skipped");
    expect(skipped).toHaveLength(8);
    expect(skipped[0].note).toContain("time limit");
    expect(report.rows).toHaveLength(9);
  });
});

describe("providerHealth: the lock", () => {
  it("holds the operation lock while it runs and releases it after", async () => {
    const probe = new FakeProbe();
    let seen: string | undefined;
    const original = probe.listIds.bind(probe);
    probe.listIds = async (tabId) => {
      seen = await getActiveOperation();
      return original(tabId);
    };
    await runProviderHealth({ providers: ["claude"] }, deps(probe));
    expect(seen).toBe("providerHealth");
    expect(await getActiveOperation()).toBe("idle");
  });

  it("refuses to run while another operation holds the lock, and leaves that lock alone", async () => {
    expect(await acquireOperationLock("bulkSync")).toBe(true);
    const probe = new FakeProbe();
    await expect(runProviderHealth({}, deps(probe))).rejects.toBeInstanceOf(HealthBusyError);
    expect(probe.opened).toEqual([]);
    expect(await getActiveOperation()).toBe("bulkSync");
    await releaseOperationLock("bulkSync");
  });

  it("releases the lock and closes the tab when a step throws something unexpected", async () => {
    const probe = new FakeProbe();
    probe.tabUrl = async () => {
      throw new Error("the browser went away");
    };
    const report = await runProviderHealth({ providers: ["claude"] }, deps(probe));
    expect(row(report, "claude").findings.map((f) => f.code)).toEqual(["check.crashed"]);
    expect(probe.closed.sort()).toEqual([...probe.opened].sort());
    expect(await getActiveOperation()).toBe("idle");
  });

  it("is refused on a bad request before it takes the lock", async () => {
    await expect(runProviderHealth({ providers: ["nope"] }, deps(new FakeProbe()))).rejects.toThrow(
      HealthRequestError,
    );
    await expect(
      runProviderHealth({ providers: ["claudecode"] }, deps(new FakeProbe())),
    ).rejects.toThrow(/Unknown web provider/);
    expect(await getActiveOperation()).toBe("idle");
  });
});

describe("providerHealth: no chat text, title or id in the report", () => {
  it("leaves every sentinel out of the report, however it ends", async () => {
    const probe = new FakeProbe();
    // a failure whose message quotes the chat id, the text it choked on and a URL with the id
    const ids = idsFor("qwen");
    probe.script("qwen", (s) => {
      (s.chats as Record<string, FetchedChat>)[ids[0]] = {
        success: false,
        error: `Failed to fetch conversation ${ids[0]}: 404 at https://chat.qwen.ai/api/v2/chats/${ids[0]}?x=1`,
      };
    });
    probe.script("grok", (s) => {
      s.ids = new Error(`Unexpected token 'U', "USER-TEXT-secret" is not valid JSON`);
    });
    probe.script("deepseek", (s) => {
      const id = idsFor("deepseek")[0];
      (s.chats as Record<string, FetchedChat>)[id] = {
        success: true,
        data: { sourceId: id, title: "TITLE-leak", messages: "not an array" },
      };
    });
    const report = await runProviderHealth({}, deps(probe));
    const json = JSON.stringify(report);
    for (const needle of ["ID-", "TITLE-", "USER-TEXT-", "MODEL-TEXT-", "chat.qwen.ai/api"]) {
      expect(json, needle).not.toContain(needle);
    }
    // and the rows that failed are still readable
    expect(row(report, "qwen").note).toContain("<id>");
    expect(row(report, "grok").findings.map((f) => f.code)).toEqual(["list.failed"]);
  });

  it("the row shape holds what the design says and nothing it does not", async () => {
    const report = await runProviderHealth({ providers: ["claude"] }, deps(new FakeProbe()));
    expect(Object.keys(row(report, "claude")).sort()).toEqual(
      ["checked", "findings", "listed", "ms", "provider", "shapes", "signedIn", "status"].sort(),
    );
  });
});

describe("scrubMessage", () => {
  it("masks ids, encoded ids, URLs, uuids, long tokens and quoted runs", () => {
    const id = "chat id/with slash";
    const text = scrubMessage(
      `bad ${id} and ${encodeURIComponent(id)} at https://example.test/a/b?c=1 ` +
        `org 123e4567-e89b-12d3-a456-426614174000 token ${"x".repeat(30)} ` +
        `and Unexpected token 'Q', "some secret words" is not valid JSON`,
      [id],
    );
    expect(text).not.toContain("slash");
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("123e4567");
    expect(text).not.toContain("xxxxx");
    expect(text).not.toContain("secret");
    expect(text).toContain("<id>");
    expect(text).toContain("<url>");
  });

  it("keeps a property name in a TypeError, and caps the length", () => {
    expect(
      scrubMessage("TypeError: Cannot read properties of undefined (reading 'content')"),
    ).toContain("'content'");
    expect(scrubMessage("a ".repeat(500)).length).toBeLessThanOrEqual(201);
  });
});

describe("classifyFailure and isSignInUrl", () => {
  it("reads sign-in pages by host and by path, and ignores the rest", () => {
    expect(isSignInUrl("https://accounts.google.com/v3/signin")).toBe(true);
    expect(isSignInUrl("https://claude.ai/login")).toBe(true);
    expect(isSignInUrl("https://chat.example.test/auth")).toBe(true);
    expect(isSignInUrl("https://chatgpt.com/c/abc")).toBe(false);
    expect(isSignInUrl("https://gemini.google.com/app")).toBe(false);
    expect(isSignInUrl("not a url")).toBe(false);
    expect(isSignInUrl(undefined)).toBe(false);
  });

  it("classifies by the tab's address first, then the message", () => {
    expect(classifyFailure("anything", "chrome-error://chromewebdata/")).toBe("unreachable");
    expect(classifyFailure("anything", "https://claude.ai/login")).toBe("not-signed-in");
    expect(classifyFailure("HTTP 401")).toBe("not-signed-in");
    expect(classifyFailure("TypeError: Failed to fetch")).toBe("unreachable");
    expect(classifyFailure("Failed to fetch chat list: 500 Internal Server Error")).toBe("other");
    expect(classifyFailure("Cannot read properties of undefined")).toBe("other");
  });
});

describe("normalizeHealthOptions", () => {
  it("fills the defaults and refuses what is out of range", () => {
    expect(normalizeHealthOptions(undefined)).toMatchObject({
      chats: 2,
      timeoutMs: 40_000,
      totalMs: 240_000,
    });
    expect(() => normalizeHealthOptions({ chats: 0 })).toThrow(HealthRequestError);
    expect(() => normalizeHealthOptions({ chats: 6 })).toThrow(HealthRequestError);
    expect(() => normalizeHealthOptions({ chats: 1.5 })).toThrow(HealthRequestError);
    expect(() => normalizeHealthOptions({ timeoutMs: 100 })).toThrow(HealthRequestError);
    expect(() => normalizeHealthOptions({ providers: "claude" })).toThrow(HealthRequestError);
    expect(() => normalizeHealthOptions({ providers: [1] })).toThrow(HealthRequestError);
  });
});
