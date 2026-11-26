import { beforeAll, describe, expect, it } from "vitest";
import { importFormatFor } from "../src/options/components/ProvidersView/importFormat";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders } from "../src/providers/provider";

// HVN-101: the Providers view's Import button opens the import dialog on the format of the
// provider it belongs to. The button shows on a provider with an importer, so every such provider
// must have a format; the registry, not a hand list, says which providers those are.
describe("Providers view import format (HVN-101)", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  it("every provider with an importer has an import format", () => {
    const withImporter = getAllProviders().filter((provider) => provider.importer);
    expect(withImporter.length).toBeGreaterThan(0);
    for (const provider of withImporter) {
      expect(importFormatFor(provider.name), provider.name).toBeDefined();
    }
  });

  it("names the format each import-only provider takes", () => {
    expect(importFormatFor("claudecode")).toBe("claudecode_jsonl");
    expect(importFormatFor("codex")).toBe("codex_jsonl");
    expect(importFormatFor("pi")).toBe("pi_jsonl");
    expect(importFormatFor("openrouter")).toBe("openrouter_json");
  });

  it("names the fragment format for the provider that has no importer (HVN-163)", () => {
    const fragment = getAllProviders().find((provider) => provider.name === "fragment");
    expect(fragment?.importer).toBeUndefined();
    expect(importFormatFor("fragment")).toBe("fragment_md");
  });

  it("a web-only provider with no import format has none of its own", () => {
    expect(importFormatFor("grok")).toBeUndefined();
    expect(importFormatFor("no-such-provider")).toBeUndefined();
  });
});
