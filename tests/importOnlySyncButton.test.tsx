import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ChatTableRow } from "../src/options/components/ArchiveView/ChatTableRow";
import type { ChatMeta } from "../src/options/types";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders, isImportOnlyProvider } from "../src/providers/provider";

// HVN-102: an import-only chat has no web source to sync from, so its Archive row offers no
// Sync Now. The rule reads `importOnly` from the registry; no provider name is listed here.

function chatFrom(source: string): ChatMeta {
  return { id: `${source}-1`, source, title: "A chat", sourceId: "s1" };
}

function rowMarkup(source: string): string {
  return renderToStaticMarkup(
    <ChatTableRow
      chat={chatFrom(source)}
      isSelected={false}
      onToggleSelect={() => {}}
      onAction={() => {}}
    />,
  );
}

describe("import-only providers in the registry (HVN-102)", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  it("reports importOnly for each registered provider exactly as its definition says", () => {
    for (const provider of getAllProviders()) {
      expect(isImportOnlyProvider(provider.name), provider.name).toBe(provider.importOnly === true);
    }
  });

  it("reports a name the registry does not know as not import-only", () => {
    expect(isImportOnlyProvider("no-such-provider")).toBe(false);
  });
});

describe("Archive row Sync Now (HVN-102)", () => {
  beforeAll(() => {
    registerAllProviders();
    // The shared test setup has no runtime.getURL; the row's icon calls it.
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it("offers Sync Now on a web provider's row", () => {
    expect(rowMarkup("claude")).toContain('title="Sync Now"');
  });

  it("offers no Sync Now on the row of any import-only provider", () => {
    const importOnly = getAllProviders().filter((provider) => provider.importOnly);
    expect(importOnly.length).toBeGreaterThan(0);
    for (const provider of importOnly) {
      expect(rowMarkup(provider.name), provider.name).not.toContain("Sync Now");
    }
  });

  it("keeps the other row actions on an import-only row", () => {
    const markup = rowMarkup("codex");
    expect(markup).toContain('title="Export"');
    expect(markup).toContain('title="Open in Viewer"');
    expect(markup).toContain('title="Delete"');
  });
});
