import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import type { BulkSyncState } from "../src/background/bulkSync/types";
import { ProviderCard } from "../src/options/components/ProvidersView/ProviderCard";
import { registerAllProviders } from "../src/providers/index";
import { getProvider } from "../src/providers/provider";
import { bulkSyncViewFor, DISCOVERING_LABEL, isBulkSyncActive } from "../src/utils/bulkSyncView";

// HVN-126: the popup and the Providers page show a sync that is still looking for its chats.
// popup.ts runs against the DOM when it loads and is not unit-testable; the rule it and the
// Providers page share is `bulkSyncViewFor`, tested here, and the Providers card is rendered.

function state(overrides: Partial<BulkSyncState>): BulkSyncState {
  return {
    status: "running",
    provider: "gemini",
    tabId: 0,
    extractionTabId: 1,
    chatIds: [],
    total: 0,
    currentIndex: 0,
    isCancelled: false,
    failedSyncs: [],
    skippedCount: 0,
    platformName: "gemini",
    overwriteExisting: false,
    startedAt: 0,
    lastProgressAt: 0,
    processedChatIds: [],
    ...overrides,
  };
}

describe("bulkSyncViewFor", () => {
  it("shows the in-progress view for a run that is still discovering, with no percentage", () => {
    const view = bulkSyncViewFor(state({ status: "discovering" }), "gemini");

    expect(view).toEqual({ active: true, discovering: true, percent: 0 });
  });

  it("gives the percentage of a running sync", () => {
    const view = bulkSyncViewFor(
      state({ status: "running", total: 8, currentIndex: 2, chatIds: ["a"] }),
      "gemini",
    );

    expect(view).toEqual({ active: true, discovering: false, percent: 25 });
  });

  it("does not divide by a total of zero", () => {
    const view = bulkSyncViewFor(state({ status: "running", total: 0 }), "gemini");

    expect(view.percent).toBe(0);
    expect(Number.isNaN(view.percent)).toBe(false);
  });

  it("shows a run for its own provider only", () => {
    const discovering = state({ status: "discovering" });

    expect(bulkSyncViewFor(discovering, "claude").active).toBe(false);
    expect(bulkSyncViewFor(discovering, undefined).active).toBe(false);
    expect(bulkSyncViewFor(null, "gemini").active).toBe(false);
  });

  it("shows nothing for a paused, cancelled or finished state", () => {
    for (const status of ["paused", "cancelled", "complete", "error"] as const) {
      expect(bulkSyncViewFor(state({ status }), "gemini").active, status).toBe(false);
    }
  });
});

describe("isBulkSyncActive", () => {
  it("is true while discovering or running, whatever the provider", () => {
    expect(isBulkSyncActive(state({ status: "discovering" }))).toBe(true);
    expect(isBulkSyncActive(state({ status: "running" }))).toBe(true);
    expect(isBulkSyncActive(state({ status: "cancelled" }))).toBe(false);
    expect(isBulkSyncActive(null)).toBe(false);
  });
});

describe("the Providers card of a sync that is discovering", () => {
  beforeAll(() => {
    registerAllProviders();
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  function card(syncState: Parameters<typeof ProviderCard>[0]["syncState"]) {
    const provider = getProvider("gemini");
    if (!provider) throw new Error("gemini is not registered");
    return renderToStaticMarkup(
      <ProviderCard
        provider={provider}
        stats={{ downloaded: 3 }}
        syncState={syncState}
        onCancelSync={() => {}}
      />,
    );
  }

  it("says it is discovering, offers Cancel Sync, and shows no percentage", () => {
    const markup = card({
      isSyncing: true,
      discovering: true,
      progress: 0,
      status: DISCOVERING_LABEL,
    });

    expect(markup).toContain("Discovering chats...");
    expect(markup).toContain("Cancel Sync");
    expect(markup).not.toContain("%</span>");
    expect(markup).not.toContain("Sync All");
  });

  it("still shows the percentage once the chats are known", () => {
    const markup = card({
      isSyncing: true,
      progress: 25,
      status: "Syncing 2/8...",
    });

    expect(markup).toContain("Syncing 2/8...");
    expect(markup).toContain("25%</span>");
  });
});
