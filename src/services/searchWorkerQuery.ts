import { normalizeSearchToken, type ParsedQuery, type QueryTerm } from "./searchQuery";
import { isStopWord } from "./searchStopWords";

/** One thing to ask the index for. */
export type QueryClause = {
  /** A word, or, when `phrase` is set, the words of a quoted phrase as typed. */
  term: string;
  /** `required`: the chat must have it. `optional`: it helps. `excluded`: the chat must not. */
  presence: "required" | "optional" | "excluded";
  prefix: boolean;
  /** `term` is several words that must stand next to each other, in that order. */
  phrase?: boolean;
  editDistance?: number;
};

export type QueryPlan = {
  clauses: QueryClause[];
};

function isIndexedTerm(term: string): boolean {
  const normalized = normalizeSearchToken(term);
  return normalized !== "" && !isStopWord(normalized);
}

function requiredClause(term: QueryTerm): QueryClause {
  return {
    term: term.text,
    presence: "required",
    prefix: term.prefix,
    ...(term.editDistance ? { editDistance: term.editDistance } : {}),
  };
}

/**
 * What to ask the index for, from a parsed query. A word that is not a prefix or a near spelling
 * is dropped when it is a stop word (the index holds it, but it says nothing), unless the query
 * has nothing else. A phrase keeps every word it was typed with, stop words too: the index
 * matches it by position, so `"to be"` finds exactly the chats that say it.
 */
export function buildQueryPlan(parsed: ParsedQuery): QueryPlan {
  const clauses: QueryClause[] = [];

  for (const phrase of parsed.phrases) {
    clauses.push({ term: phrase, presence: "required", prefix: false, phrase: true });
  }

  const plain = (term: QueryTerm) => !term.prefix && !term.editDistance;
  const words = parsed.required.filter((term) => !plain(term) || isIndexedTerm(term.text));
  // A query of stop words only ("to be or not to be") keeps them; next to a phrase, they go.
  const kept = words.length > 0 || parsed.phrases.length > 0 ? words : parsed.required;
  for (const term of kept) clauses.push(requiredClause(term));

  for (const term of parsed.excluded) {
    clauses.push({ term, presence: "excluded", prefix: false });
  }

  return { clauses };
}

/**
 * The plan for a search that found nothing: any of the words, as prefixes, without the stop words
 * (a question that matched on `how*` alone is not an answer). Null when the query has no word that
 * can be relaxed, or has a phrase, which is exact on purpose.
 */
export function buildRelaxedPlan(parsed: ParsedQuery): QueryPlan | null {
  if (parsed.phrases.length > 0) return null;

  const candidates = parsed.required.filter((term) => term.text.length >= 3);
  const significant = candidates.filter((term) => isIndexedTerm(term.text));
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
  return { clauses };
}
