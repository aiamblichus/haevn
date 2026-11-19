import { beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_COLORS } from "../cli/src/utils/platformColors";
import { registerAllProviders } from "../src/providers/index";
import { getAllProviders } from "../src/providers/provider";

// HVN-103: the CLI prints each platform in its colour from a list it keeps itself, because it
// cannot import the extension's registry. This test holds that list to the registry: the same
// names, import-only providers included, and nothing the registry does not have.
describe("CLI platform colours (HVN-103)", () => {
  beforeAll(() => {
    registerAllProviders();
  });

  it("names exactly the providers the registry has", () => {
    const cliNames = [...PLATFORM_COLORS.keys()].sort();
    const registryNames = getAllProviders()
      .map((provider) => provider.name)
      .sort();
    expect(cliNames).toEqual(registryNames);
  });
});
