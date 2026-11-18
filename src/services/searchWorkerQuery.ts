import lunr from "lunr";
import { createQueryTermPipeline } from "./searchPipeline";
import { normalizeSearchToken, splitQuotedSearchQuery, trimSearchTerm } from "./searchQuery";

export type PhraseConstraint = {
  normalizedPhrase: string;
  terms: string[];
  requiresTextVerification: boolean;
};

export type LunrQueryPlan = {
  finalQuery: string;
  hasPhrases: boolean;
  phraseConstraints: PhraseConstraint[];
};

function keepIndexedTerm(term: string, stopWordPipeline: lunr.Pipeline): boolean {
  const normalized = normalizeSearchToken(term);
  if (!normalized) return false;
  return stopWordPipeline.run([new lunr.Token(normalized, {})]).length > 0;
}

/**
 * Build the Lunr query text and phrase constraints used by the search worker.
 *
 * Query-side normalization is intentional here: we lowercase tokens before
 * stop-word filtering and before constructing implicit AND queries so mixed-case
 * searches behave the same as lowercase ones.
 */
export function buildLunrQueryPlan(query: string): LunrQueryPlan {
  const { phrases, remainderParts } = splitQuotedSearchQuery(query);
  const phraseConstraints: PhraseConstraint[] = [];
  const parts: string[] = [];
  const stopWordPipeline = createQueryTermPipeline();

  for (const phrase of phrases) {
    const terms = phrase.split(/\s+/).map(normalizeSearchToken).filter(Boolean);
    if (terms.length === 0) continue;

    const filteredTerms = terms.filter((term) => keepIndexedTerm(term, stopWordPipeline));
    phraseConstraints.push({
      normalizedPhrase: phrase,
      terms,
      requiresTextVerification: filteredTerms.length !== terms.length,
    });

    if (filteredTerms.length > 0) {
      parts.push(filteredTerms.map((term) => `+${term}`).join(" "));
    }
  }

  const remainder = remainderParts.join(" ").replace(/\s+/g, " ").trim();
  if (remainder) parts.push(remainder);

  if (phraseConstraints.length > 0) {
    return {
      finalQuery: parts.join(" "),
      hasPhrases: true,
      phraseConstraints,
    };
  }

  if (!/[+\-~*^"]/.test(query)) {
    const normalizedTerms = query.split(/\s+/).map(normalizeSearchToken).filter(Boolean);
    const filteredTerms = normalizedTerms.filter((term) => keepIndexedTerm(term, stopWordPipeline));
    const implicitAndTerms = filteredTerms.length > 0 ? filteredTerms : normalizedTerms;

    return {
      finalQuery: implicitAndTerms.map((term) => `+${term}`).join(" "),
      hasPhrases: false,
      phraseConstraints,
    };
  }

  return {
    finalQuery: query,
    hasPhrases: false,
    phraseConstraints,
  };
}

export function queryNeedsExactPhrasePath(query: string): boolean {
  return buildLunrQueryPlan(query).phraseConstraints.some(
    (constraint) => constraint.requiresTextVerification,
  );
}

export function buildRelaxedPrefixQuery(query: string): string | null {
  const relaxedTerms = query
    .split(/\s+/)
    .map((term) => trimSearchTerm(normalizeSearchToken(term).replace(/[+\-~*^:"()]/g, "")))
    .filter((term) => term.length >= 3)
    .map((term) => `${term}*`);

  return relaxedTerms.length > 0 ? relaxedTerms.join(" ") : null;
}
