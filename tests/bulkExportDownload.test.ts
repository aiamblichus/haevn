import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isDownloadEstablished,
  isDownloadSettled,
  waitForDownloadEstablished,
  waitForDownloadSettled,
} from "../src/background/bulkExport/bulkExport";

const DOWNLOAD_ID = 7;
const originalChrome = globalThis.chrome;

type Listener = (delta: chrome.downloads.DownloadDelta) => void;
type Step = "error" | { state: string; bytesReceived: number };

interface FakeDownloads {
  emit(delta: chrome.downloads.DownloadDelta): void;
  listenerCount(): number;
  searches(): number;
}

/**
 * Stubs chrome.downloads for one download. Each search answers the next step and then keeps
 * answering the last one; "error" makes the search report chrome.runtime.lastError.
 */
function stubDownloads(steps: Step[]): FakeDownloads {
  const listeners = new Set<Listener>();
  const runtime: { lastError?: { message: string } } = {};
  let searchCount = 0;
  const stub = {
    runtime,
    downloads: {
      onChanged: {
        addListener: (listener: Listener) => {
          listeners.add(listener);
        },
        removeListener: (listener: Listener) => {
          listeners.delete(listener);
        },
      },
      search: (
        _query: { id: number },
        callback: (items: chrome.downloads.DownloadItem[]) => void,
      ) => {
        const step = steps[Math.min(searchCount, steps.length - 1)];
        searchCount += 1;
        if (step === "error") {
          runtime.lastError = { message: "search failed" };
          callback([]);
          runtime.lastError = undefined;
          return;
        }
        callback([{ id: DOWNLOAD_ID, ...step } as chrome.downloads.DownloadItem]);
      },
    },
  };
  vi.stubGlobal("chrome", stub as unknown as typeof chrome);
  return {
    emit: (delta) => {
      for (const listener of listeners) listener(delta);
    },
    listenerCount: () => listeners.size,
    searches: () => searchCount,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.stubGlobal("chrome", originalChrome);
});

describe("download progress decisions", () => {
  it("counts a download as established once it has received bytes", () => {
    expect(isDownloadEstablished({ bytesReceived: 0 })).toBe(false);
    expect(isDownloadEstablished({ bytesReceived: 4096 })).toBe(true);
  });

  it("settles on complete, interrupted or a missing record, not while in progress", () => {
    expect(isDownloadSettled({ state: "in_progress" })).toBe(false);
    expect(isDownloadSettled({ state: "complete" })).toBe(true);
    expect(isDownloadSettled({ state: "interrupted" })).toBe(true);
    expect(isDownloadSettled(undefined)).toBe(true);
  });
});

describe("waitForDownloadEstablished", () => {
  it("is established from polled bytes when onChanged reports no state change", async () => {
    const downloads = stubDownloads([
      { state: "in_progress", bytesReceived: 0 },
      { state: "in_progress", bytesReceived: 0 },
      { state: "in_progress", bytesReceived: 2048 },
    ]);
    const result = waitForDownloadEstablished(DOWNLOAD_ID, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe(true);
    expect(downloads.searches()).toBe(3);
    expect(downloads.listenerCount()).toBe(0);
  });

  it("gives up after the timeout when no bytes arrive, polling until then", async () => {
    const downloads = stubDownloads([{ state: "in_progress", bytesReceived: 0 }]);
    const result = waitForDownloadEstablished(DOWNLOAD_ID, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toBe(false);
    expect(downloads.searches()).toBeGreaterThan(1);
    expect(downloads.listenerCount()).toBe(0);
  });

  it("is established at once by a state change in onChanged", async () => {
    const downloads = stubDownloads([{ state: "in_progress", bytesReceived: 0 }]);
    const result = waitForDownloadEstablished(DOWNLOAD_ID, 10_000);
    downloads.emit({ id: DOWNLOAD_ID, state: { current: "in_progress" } });
    await expect(result).resolves.toBe(true);
    expect(downloads.listenerCount()).toBe(0);
  });
});

describe("waitForDownloadSettled", () => {
  it("resolves only once the download is complete, through in-progress and failed searches", async () => {
    const downloads = stubDownloads([
      { state: "in_progress", bytesReceived: 100 },
      "error",
      { state: "in_progress", bytesReceived: 900 },
      { state: "complete", bytesReceived: 1000 },
    ]);
    let settled = false;
    const done = waitForDownloadSettled(DOWNLOAD_ID).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(settled).toBe(true);
    expect(downloads.searches()).toBe(4);
  });

  it("resolves at once for a download that has already failed", async () => {
    const downloads = stubDownloads([{ state: "interrupted", bytesReceived: 0 }]);
    await waitForDownloadSettled(DOWNLOAD_ID);
    expect(downloads.searches()).toBe(1);
  });
});
