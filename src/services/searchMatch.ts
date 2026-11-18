// The query language of the index (SQLite FTS5's MATCH), built from a `QueryPlan`: the one place
// that makes it. Nothing the reader typed is ever put into a MATCH string as it stands. A word
// is quoted whole, so that no word of the query can be taken for an operator (`AND`, `NOT`, `*`,
// a colon, a bracket), and FTS5 cuts and folds the quoted text with the tokenizer of the index,
// which is what makes `café` find `cafe`.

import type { QueryClause, QueryPlan } from "./searchWorkerQuery";

/** The words of the index within `maxEdits` edits of `term`, for the clauses typed `word~N`. */
export type Variants = (term: string, maxEdits: number) => string[];

/** `text` as an FTS5 string: in double quotes, with a quote inside doubled. */
export function quoteMatch(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

function clauseMatch(clause: QueryClause, variants: Variants): string {
  if (clause.phrase) return quoteMatch(clause.term);
  if (clause.editDistance) {
    const near = variants(clause.term, clause.editDistance);
    // A word the index has no neighbour of is still asked for as typed, and finds nothing.
    return near.length > 1
      ? `(${near.map(quoteMatch).join(" OR ")})`
      : quoteMatch(near[0] ?? clause.term);
  }
  // The star goes on the last word of the quoted text: `"foo.b" *` is `foo` then any `b...`.
  return clause.prefix ? `${quoteMatch(clause.term)} *` : quoteMatch(clause.term);
}

/** The plan in the three groups the index answers separately. */
export interface PlanMatches {
  /** One MATCH per clause the chat must satisfy; a chat is a result when every one holds. */
  required: string[];
  /** Clauses of which any one will do (the relaxed plan). */
  optional: string[];
  /** Clauses a chat must not satisfy (`-word`). */
  excluded: string[];
}

export function buildMatches(plan: QueryPlan, variants: Variants): PlanMatches {
  const matches: PlanMatches = { required: [], optional: [], excluded: [] };
  for (const clause of plan.clauses) {
    matches[clause.presence].push(clauseMatch(clause, variants));
  }
  return matches;
}

/** `parts` as one MATCH, any of them; null for none. */
export function anyOf(parts: string[]): string | null {
  return parts.length === 0 ? null : parts.join(" OR ");
}

/**
 * The edit distance of `a` and `b` (insert, delete, change one character), or `max + 1` as soon as
 * it is known to be more than `max`. Counted in code points, so an astral letter is one edit.
 */
export function editDistanceWithin(a: string, b: string, max: number): number {
  const left = Array.from(a);
  const right = Array.from(b);
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      current[j] = value;
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[right.length];
}
