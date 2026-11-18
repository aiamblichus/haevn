import lunr from "lunr";
import { createQueryTermPipeline } from "./searchPipeline";
import { normalizeSearchToken, type ParsedQuery, type QueryTerm } from "./searchQuery";

export type PhraseConstraint = {
  normalizedPhrase: string;
  terms: string[];
  requiresTextVerification: boolean;
};

/** One thing to ask the index for. */
export type QueryClause = {
  term: string;
  /** `required`: the chat must have it. `optional`: it helps. `excluded`: the chat must not. */
  presence: "required" | "optional" | "excluded";
  prefix: boolean;
  editDistance?: number;
  boost?: number;
};

export type QueryPlan = {
  clauses: QueryClause[];
  hasPhrases: boolean;
  phraseConstraints: PhraseConstraint[];
};

function isIndexedTerm(term: string, stopWordPipeline: lunr.Pipeline): boolean {
  const normalized = normalizeSearchToken(term);
  if (!normalized) return false;
  return stopWordPipeline.run([new lunr.Token(normalized, {})]).length > 0;
}

function requiredClause(term: QueryTerm): QueryClause {
  return {
    term: term.text,
    presence: "required",
    prefix: term.prefix,
    ...(term.editDistance ? { editDistance: term.editDistance } : {}),
    ...(term.boost ? { boost: term.boost } : {}),
  };
}

/**
 * What to ask the index for, from a parsed query. A word that is not a prefix or a near spelling
 * is dropped when it is a stop word (the index would hold it, but it says nothing), unless the
 * query has nothing else; a phrase keeps its words in the plan whatever they are, and the
 * constraint says whether the text has to confirm it.
 */
export function buildQueryPlan(parsed: ParsedQuery): QueryPlan {
  const stopWordPipeline = createQueryTermPipeline();
  const clauses: QueryClause[] = [];
  const phraseConstraints: PhraseConstraint[] = [];

  for (const phrase of parsed.phrases) {
    const terms = phrase
      .split(/[\s-]+/)
      .map(normalizeSearchToken)
      .filter(Boolean);
    if (terms.length === 0) continue;

    const indexed = terms.filter((term) => isIndexedTerm(term, stopWordPipeline));
    phraseConstraints.push({
      normalizedPhrase: phrase,
      terms,
      requiresTextVerification: indexed.length !== terms.length,
    });
    // A phrase of stop words only ("to be") still has to find the chats that have them.
    for (const term of indexed.length > 0 ? indexed : terms) {
      clauses.push({ term, presence: "required", prefix: false });
    }
  }

  const plain = (term: QueryTerm) => !term.prefix && !term.editDistance;
  const words = parsed.required.filter(
    (term) => !plain(term) || isIndexedTerm(term.text, stopWordPipeline),
  );
  // A query of stop words only ("to be or not to be") keeps them; next to a phrase, they go.
  const kept = words.length > 0 || parsed.phrases.length > 0 ? words : parsed.required;
  for (const term of kept) clauses.push(requiredClause(term));

  for (const term of parsed.excluded) {
    clauses.push({ term, presence: "excluded", prefix: false });
  }

  return { clauses, hasPhrases: phraseConstraints.length > 0, phraseConstraints };
}

/**
 * The plan for a search that found nothing: any of the words, as prefixes, without the stop words
 * (a question that matched on `how*` alone is not an answer). Null when the query has no word that
 * can be relaxed, or has a phrase, which is exact on purpose.
 */
export function buildRelaxedPlan(parsed: ParsedQuery): QueryPlan | null {
  if (parsed.phrases.length > 0) return null;
  const stopWordPipeline = createQueryTermPipeline();

  const candidates = parsed.required.filter((term) => term.text.length >= 3);
  const significant = candidates.filter((term) => isIndexedTerm(term.text, stopWordPipeline));
  const relaxed = significant.length > 0 ? significant : candidates;
  if (relaxed.length === 0) return null;

  const clauses: QueryClause[] = relaxed.map((term) => ({
    term: term.text,
    presence: "optional",
    prefix: true,
  }));
  for (const term of parsed.excluded) {
    clauses.push({ term, presence: "excluded", prefix: false });
  }
  return { clauses, hasPhrases: false, phraseConstraints: [] };
}

/** Put the clauses on a Lunr query: the one place that speaks Lunr's query API. */
export function applyClauses(query: lunr.Query, clauses: QueryClause[]): void {
  const presence = {
    required: lunr.Query.presence.REQUIRED,
    optional: lunr.Query.presence.OPTIONAL,
    excluded: lunr.Query.presence.PROHIBITED,
  };
  for (const clause of clauses) {
    query.term(clause.term, {
      presence: presence[clause.presence],
      // A prefix is already trimmed and lower case, and Lunr does not run a pipeline over one.
      ...(clause.prefix ? { wildcard: lunr.Query.wildcard.TRAILING, usePipeline: false } : {}),
      ...(clause.editDistance ? { editDistance: clause.editDistance } : {}),
      ...(clause.boost ? { boost: clause.boost } : {}),
    });
  }
}

export function queryNeedsExactPhrasePath(parsed: ParsedQuery): boolean {
  return buildQueryPlan(parsed).phraseConstraints.some(
    (constraint) => constraint.requiresTextVerification,
  );
}
