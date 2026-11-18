import lunr from "lunr";
import { wordBounds } from "./searchSnippet";

/**
 * The format of the segments in the `lunrIndex` store: what a term is. A stored index is read only
 * when this is the version it was built with; any other (older, newer, or none written) is
 * rebuilt once (HVN-65). Raise it when the pipeline or the fields change what the index holds.
 *   1: terms are trimmed of punctuation (before it, a term kept its comma and its brackets).
 */
export const INDEX_FORMAT_VERSION = 1;

const TRIMMER_LABEL = "haevnTrimmer";

function createWordTrimmer(): lunr.PipelineFunction {
  return (token) =>
    token.update((term) => {
      const { start, end } = wordBounds(term);
      return term.slice(start, end);
    });
}

/**
 * `lunr.trimmer` for text in any script. Lunr's own strips everything `\W` matches, which is
 * every letter outside ASCII: a Cyrillic, Greek or CJK word is trimmed to nothing and indexed
 * as the empty term. This one keeps letters, marks and digits (`wordBounds`), the same rule the
 * snippet marks use.
 *
 * Registered under a label so a persisted index, which stores the names of its search pipeline's
 * functions, loads. A worker module that is loaded twice in one realm reuses the first function.
 */
export const wordTrimmer: lunr.PipelineFunction = (() => {
  const registered = (lunr.Pipeline as unknown as { registeredFunctions: Record<string, unknown> })
    .registeredFunctions;
  const existing = registered[TRIMMER_LABEL] as lunr.PipelineFunction | undefined;
  if (existing) return existing;
  const trimmer = createWordTrimmer();
  lunr.Pipeline.registerFunction(trimmer, TRIMMER_LABEL);
  return trimmer;
})();

/**
 * The one way the worker makes a Lunr builder, for the first segment, a rebuilt segment and a
 * hydrated one alike, so that no site indexes differently from another. The trimmer runs on the
 * indexed terms and on the query's, so a term and a search agree on "wombatz" in "wombatz," and
 * "(wombatz)". There is no stemmer: a search matches the word as written, or as a prefix.
 */
export function createIndexBuilder(): lunr.Builder {
  const builder = new lunr.Builder();
  builder.pipeline.add(wordTrimmer);
  builder.searchPipeline.add(wordTrimmer);
  builder.ref("id");
  builder.field("title", { boost: 10 });
  builder.field("content");
  builder.metadataWhitelist = ["position"];
  return builder;
}

/** The pipeline the query side mirrors to decide which terms the index holds: trim, then drop stop words. */
export function createQueryTermPipeline(): lunr.Pipeline {
  const pipeline = new lunr.Pipeline();
  pipeline.add(wordTrimmer, lunr.stopWordFilter);
  return pipeline;
}
