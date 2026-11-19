import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ChatTableRow } from "../src/options/components/ArchiveView/ChatTableRow";
import { SearchResultGroup } from "../src/options/components/ArchiveView/SearchResultGroup";
import type { ChatMeta } from "../src/options/types";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders } from "../src/providers/provider";

// HVN-111: an import-only chat has no provider to open, so its rows offer no Open at Provider. The
// rule is the registry's (HVN-102), as for Sync Now.

const OPEN_TITLE = 'title="Open at Provider"';

function chatFrom(source: string): ChatMeta {
  return { id: `${source}-1`, source, title: "A chat", sourceId: "s1" };
}

function rowMarkup(source: string, canOpenProvider?: boolean): string {
  return renderToStaticMarkup(
    <ChatTableRow
      chat={chatFrom(source)}
      isSelected={false}
      onToggleSelect={() => {}}
      onAction={() => {}}
      canOpenProvider={canOpenProvider}
    />,
  );
}

function groupMarkup(source: string): string {
  return renderToStaticMarkup(
    <SearchResultGroup
      group={{ chatId: `${source}-1`, chatTitle: "A chat", source, items: [] }}
      onOpenViewer={() => {}}
      onOpenProvider={() => {}}
      onExport={() => {}}
      onMetadata={() => {}}
    />,
  );
}

describe("Open at Provider on import-only rows (HVN-111)", () => {
  beforeAll(() => {
    registerAllProviders();
    // The shared test setup has no runtime.getURL; the row's icon calls it.
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it("offers Open at Provider on a web provider's Archive row", () => {
    expect(rowMarkup("claude")).toContain(OPEN_TITLE);
  });

  it("offers no Open at Provider on the Archive row of any import-only provider", () => {
    const importOnly = getAllProviders().filter((provider) => provider.importOnly);
    expect(importOnly.length).toBeGreaterThan(0);
    for (const provider of importOnly) {
      expect(rowMarkup(provider.name), provider.name).not.toContain(OPEN_TITLE);
    }
  });

  it("offers no Open at Provider on a search result of an import-only provider", () => {
    expect(groupMarkup("claude")).toContain(OPEN_TITLE);
    expect(groupMarkup("claudecode")).not.toContain(OPEN_TITLE);
  });

  it("still honours the caller's canOpenProvider = false on a web provider", () => {
    expect(rowMarkup("claude", false)).not.toContain(OPEN_TITLE);
  });
});
