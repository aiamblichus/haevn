import {
  type FragmentFile,
  type FragmentLookup,
  type HashedFragment,
  parseFragment,
} from "../../src/providers/fragment";
import { sha256Hex } from "../../src/utils/jsonImporter";

export const ID_A = "7b0e6c1e-2f4a-4c58-9d0b-3a1f5e8c9a12";
export const ID_B = "0d1b3f58-9c2e-4e7a-8a61-5c4f2b9d7e10";
export const ID_C = "c3a9d2f4-1b7e-4d65-b0a8-6e5f4c3b2a19";

/** A fragment file written for a test: the frontmatter lines (an `id` is not added), then the body. */
export function fragmentFile(
  frontmatter: string,
  body: string,
  name = "fragment.md",
): FragmentFile {
  return { name, content: `---\n${frontmatter}\n---\n${body}` };
}

/** A file with a valid id and whatever else the test says. */
export function withId(extra: string, body: string, id = ID_A, name = "fragment.md"): FragmentFile {
  return fragmentFile(`id: ${id}${extra ? `\n${extra}` : ""}`, body, name);
}

/** Parses a file that must parse, and hashes it as the plan does. */
export async function parsed(file: FragmentFile): Promise<HashedFragment> {
  const outcome = parseFragment(file);
  if (!outcome.ok)
    throw new Error(`${file.name} was refused: ${outcome.state} (${outcome.message})`);
  return {
    ...outcome.fragment,
    fileSha256: await sha256Hex(file.content),
    bodySha256: await sha256Hex(outcome.fragment.body),
  };
}

/** A lookup over nothing: every file is new. */
export const emptyLookup: FragmentLookup = {
  stored: async () => undefined,
  withBody: async () => undefined,
};
