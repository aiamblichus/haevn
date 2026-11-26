/**
 * Fragment provider registration (HVN-163).
 *
 * Import-only: a fragment is a recovered chat that no platform holds any more, so there is nothing
 * to sync it from. It has no `importer` either: the files are planned and imported as a batch by
 * `importFragments`, because a refused file must not stop the others and an unchanged one must
 * write nothing.
 */

import type { Extractor, Transformer } from "../interfaces";
import type { Provider } from "../provider";
import type { HashedFragment } from "./model";
import { transformFragmentToHaevnChat } from "./transformer";

const extractor: Extractor<HashedFragment> = {
  isPlatform: () => false,
  extractChatIdFromUrl: () => null,
  extractData: async () => {
    throw new Error("Fragments are import-only (no live sync)");
  },
};

const transformer: Transformer<HashedFragment> = {
  transform: async (raw: HashedFragment) => [transformFragmentToHaevnChat(raw)],

  validate: (raw: HashedFragment) => {
    const errors: string[] = [];
    if (!raw.id) errors.push("Missing id");
    if (raw.turns.length === 0) errors.push("No turns found");
    return { valid: errors.length === 0, errors };
  },
};

export const fragmentProvider: Provider<HashedFragment> = {
  name: "fragment",
  displayName: "Fragment",
  importOnly: true,
  extractor,
  transformer,
  setup() {
    // No setup needed for an import-only provider
  },
  getListUrl(): string {
    return "";
  },
  buildChatUrl(): string {
    return "";
  },
};
