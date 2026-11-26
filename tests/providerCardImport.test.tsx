import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { ProviderCard } from "../src/options/components/ProvidersView/ProviderCard";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders } from "../src/providers/provider";

// HVN-163, slice 3: the Fragment card gets an Import button (the fragment provider has no importer:
// its files are planned as a batch), and an import-only card no longer says to sync from the popup.

function card(name: string, onImport?: () => void): string {
  const provider = getAllProviders().find((candidate) => candidate.name === name);
  if (!provider) throw new Error(`no provider ${name}`);
  return renderToStaticMarkup(
    <ProviderCard
      provider={provider}
      stats={{ downloaded: 0 }}
      syncState={{ isSyncing: false, progress: 0, status: "" }}
      onImport={onImport}
    />,
  );
}

describe("the Providers view cards (HVN-163, slice 3)", () => {
  beforeAll(() => {
    registerAllProviders();
    (
      globalThis as unknown as { chrome: { runtime: { getURL: (p: string) => string } } }
    ).chrome.runtime.getURL = (path: string) => `chrome-extension://test/${path}`;
  });

  it("shows Import on the Fragment card when the page gives it one", () => {
    expect(card("fragment", () => {})).toContain(">Import<");
    expect(card("fragment")).not.toContain(">Import<");
  });

  it("says an import-only card is imported from files, not synced from the popup", () => {
    const importOnly = getAllProviders().filter((provider) => provider.importOnly);
    expect(importOnly.map((provider) => provider.name)).toContain("fragment");
    for (const provider of importOnly) {
      const markup = card(provider.name, () => {});
      expect(markup, provider.name).toContain("Imported from files");
      expect(markup, provider.name).not.toContain("Sync from popup");
    }
  });

  it("keeps the popup's line on a web provider that cannot sync all", () => {
    const web = getAllProviders().find((provider) => !provider.importOnly);
    expect(web).toBeDefined();
    expect(card(web?.name ?? "")).toContain("Sync from popup when on provider page");
  });
});
