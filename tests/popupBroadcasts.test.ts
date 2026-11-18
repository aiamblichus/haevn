import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenForPopupBroadcasts } from "../src/popup/popupBroadcasts";

type RuntimeListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => unknown;

// A fake chrome.runtime that keeps the listeners the code registers, so a test can call them the
// way the browser does. The popup is one of many listeners on the same messages.
let registered: RuntimeListener[] = [];
let previousChrome: unknown;

beforeEach(() => {
  registered = [];
  previousChrome = (globalThis as { chrome?: unknown }).chrome;
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (listener: RuntimeListener) => {
          registered.push(listener);
        },
      },
    },
  });
});

afterEach(() => {
  vi.stubGlobal("chrome", previousChrome);
});

function registerPopupListener(onBroadcast = vi.fn(async () => {})) {
  listenForPopupBroadcasts(onBroadcast);
  expect(registered).toHaveLength(1);
  return { listener: registered[0], onBroadcast };
}

describe("popup broadcast listener", () => {
  it("returns nothing for an action the service worker answers", () => {
    const { listener, onBroadcast } = registerPopupListener();
    const sendResponse = vi.fn();

    for (const message of [
      { action: "searchChats", query: "pineapple" },
      { action: "getBulkSyncState" },
      { action: "cancelBulkSync" },
      { action: "getSyncedChatsMetadata", offset: 0, limit: 25 },
    ]) {
      expect(listener(message, {}, sendResponse)).toBeUndefined();
    }

    expect(onBroadcast).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("returns nothing for a message without an action, or no message at all", () => {
    const { listener, onBroadcast } = registerPopupListener();
    const sendResponse = vi.fn();

    for (const message of [{ type: "workerMessage", data: { requestId: "r1" } }, null, "text"]) {
      expect(listener(message, {}, sendResponse)).toBeUndefined();
    }

    expect(onBroadcast).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("hands the popup's own broadcasts to the handler, and still returns nothing", () => {
    const { listener, onBroadcast } = registerPopupListener();
    const sendResponse = vi.fn();
    const progress = { action: "bulkSyncProgress", provider: "claude", progress: 40 };
    const complete = { action: "bulkSyncComplete", provider: "claude" };
    const synced = { action: "chatSynced" };

    expect(listener(progress, {}, sendResponse)).toBeUndefined();
    expect(listener(complete, {}, sendResponse)).toBeUndefined();
    expect(listener(synced, {}, sendResponse)).toBeUndefined();

    expect(onBroadcast).toHaveBeenCalledTimes(3);
    expect(onBroadcast).toHaveBeenNthCalledWith(1, progress);
    expect(onBroadcast).toHaveBeenNthCalledWith(2, complete);
    expect(onBroadcast).toHaveBeenNthCalledWith(3, synced);
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
