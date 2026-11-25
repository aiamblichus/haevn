import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogEntry } from "../src/utils/logger/types";

// HVN-157: the entries persisted before the logs were cleaned of chat content hold message text,
// titles and search queries. The first start of the logger on a newer format clears them once, and
// writes the format it keeps them in.

const ENTRIES_KEY = "logger:entries";
const FORMAT_KEY = "logger:format";

let stored: Map<string, unknown>;
let removed: string[];

function entry(message: string): LogEntry {
  return { id: message, timestamp: 1, level: "INFO", message, context: "background" };
}

function stubStorage() {
  chromeStub({
    get: async (keys?: string | string[] | null) => {
      const wanted = keys == null ? [...stored.keys()] : Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(wanted.filter((k) => stored.has(k)).map((k) => [k, stored.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) stored.set(k, structuredClone(v));
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        removed.push(k);
        stored.delete(k);
      }
    },
  });
}

function chromeStub(local: object) {
  vi.stubGlobal("chrome", { storage: { local } });
}

/** A logger service as a fresh start of the service worker has it. */
async function freshService() {
  vi.resetModules();
  const { loggerService } = await import("../src/services/loggerService");
  return loggerService;
}

/** What the service holds after its init, as the next persist writes it. */
async function persistedAfterInit(service: Awaited<ReturnType<typeof freshService>>) {
  await service.init();
  await (service as unknown as { persistLogs(): Promise<void> }).persistLogs();
  return (stored.get(ENTRIES_KEY) as LogEntry[] | undefined) ?? [];
}

beforeEach(() => {
  stored = new Map();
  removed = [];
  stubStorage();
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the one-time purge of persisted log entries (HVN-157)", () => {
  it("clears the entries stored before the format was marked, and marks it", async () => {
    stored.set(ENTRIES_KEY, [entry("old entry with a chat title")]);

    const kept = await persistedAfterInit(await freshService());

    expect(kept).toEqual([]);
    expect(removed).toEqual([ENTRIES_KEY]);
    expect(stored.get(FORMAT_KEY)).toBe(1);
  });

  it("clears the entries of an older format", async () => {
    stored.set(ENTRIES_KEY, [entry("old entry")]);
    stored.set(FORMAT_KEY, 0);

    expect(await persistedAfterInit(await freshService())).toEqual([]);
    expect(stored.get(FORMAT_KEY)).toBe(1);
  });

  it("fires once: the next starts keep the entries written since", async () => {
    stored.set(ENTRIES_KEY, [entry("old entry")]);
    const first = await freshService();
    await first.init();
    first.addEntry(entry("new entry"));
    await (first as unknown as { persistLogs(): Promise<void> }).persistLogs();

    const second = await persistedAfterInit(await freshService());
    const third = await persistedAfterInit(await freshService());

    expect(second.map((e) => e.message)).toEqual(["new entry"]);
    expect(third.map((e) => e.message)).toEqual(["new entry"]);
    expect(removed).toEqual([ENTRIES_KEY]); // the one clear, at the first start
  });

  it("keeps the entries of a format as new as this one or newer", async () => {
    stored.set(ENTRIES_KEY, [entry("kept entry")]);
    stored.set(FORMAT_KEY, 1);
    expect((await persistedAfterInit(await freshService())).map((e) => e.message)).toEqual([
      "kept entry",
    ]);

    // a later version's mark (a downgrade) is not an older format
    stored.set(FORMAT_KEY, 7);
    expect((await persistedAfterInit(await freshService())).map((e) => e.message)).toEqual([
      "kept entry",
    ]);
    expect(removed).toEqual([]);
    expect(stored.get(FORMAT_KEY)).toBe(7);
  });

  it("marks a first install, which has nothing to clear", async () => {
    expect(await persistedAfterInit(await freshService())).toEqual([]);
    expect(stored.get(FORMAT_KEY)).toBe(1);
  });

  it("keeps the saved config", async () => {
    stored.set("logger:config", { minLevel: 2, maxEntries: 1000, persistCount: 500 });
    stored.set(ENTRIES_KEY, [entry("old entry")]);

    const service = await freshService();
    await service.init();

    expect(service.getConfig().minLevel).toBe(2);
  });
});
