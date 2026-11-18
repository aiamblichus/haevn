import { wordBounds } from "./searchSnippet";

/** A search that did not run because its query has nothing to look for; the message says why. */
export class SearchQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchQueryError";
  }
}

/** One word of the query, as the index holds it. */
export type QueryTerm = {
  /** Lower case, without the punctuation typed against it. */
  text: string;
  /** Typed `word*`: any word that starts with it. */
  prefix: boolean;
  /** Typed `word~2`: words this many edits away count too. */
  editDistance?: number;
  /** Typed `word^3`: counts this many times as much. */
  boost?: number;
};

export type ParsedQuery = {
  /** The "quoted" parts, lower case, as typed. */
  phrases: string[];
  /**
   * The words to look for in a message, once each, in the order typed: the ones that must be
   * there, and not the ones to leave out or the ones that match a spelling nearby.
   */
  terms: string[];
  /** Every word the chat must have, in the order typed (a hyphenated word is one per part). */
  required: QueryTerm[];
  /** The words a chat must not have (`-word`). */
  excluded: string[];
  /** Why there is nothing to search for, when there is not. */
  problem?: string;
};

/**
 * Where the index splits a word: Lunr's own separator, which indexes `local-first` as `local`
 * and `first`. A query has to cut its words the same way to find what it typed.
 */
const WORD_SEPARATOR = /-+/;

export function normalizeSearchToken(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * A query term without the punctuation typed against it (`wombat,` is `wombat`): the index trims
 * the words of the text the same way (`wordBounds`), so a term that keeps its comma matches
 * nothing the index holds and no text that has the word bare (HVN-71).
 */
export function trimSearchTerm(term: string): string {
  const { start, end } = wordBounds(term);
  return term.slice(start, end);
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function splitQuotedSearchQuery(query: string): {
  phrases: string[];
  remainderParts: string[];
} {
  const phrases: string[] = [];
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  const remainderParts: string[] = [];

  match = quoteRegex.exec(query);
  while (match !== null) {
    const pre = query.slice(lastIndex, match.index).trim();
    if (pre) remainderParts.push(pre);

    const phrase = normalizeSearchToken(match[1] || "");
    if (phrase) phrases.push(phrase);

    lastIndex = quoteRegex.lastIndex;
    match = quoteRegex.exec(query);
  }

  const tail = query.slice(lastIndex).trim();
  if (tail) remainderParts.push(tail);

  return { phrases, remainderParts };
}

/** A minus that starts a word and is followed by a quote: `-"a phrase"`. */
const LEFT_OUT_PHRASE = /(?:^|\s)-"/;

/** `foo~2^3` or `foo^3~2`: the modifiers at the end of a word, whichever order they come in. */
const MODIFIER = /([~^])(\d+(?:\.\d+)?)$/;

type ParsedWord = { excluded: boolean; terms: QueryTerm[] };

/**
 * One whitespace-separated word of the query. The operators are the ones the CLI documents: a
 * leading `-` leaves the word out, a trailing `*` makes it a prefix, `~N` allows N edits and `^N`
 * boosts. Nothing else is an operator: a colon, a plus or a bracket is a character like the
 * others, and the edges of the word are trimmed the way the index trims the words of the text.
 */
function parseWord(raw: string): ParsedWord | null {
  // A quote or a bracket on its own (a phrase still being typed) is not a word to look for.
  if (/^["()]+$/.test(raw)) return null;

  let word = raw;
  let excluded = false;
  if (word.length > 1 && (word.startsWith("-") || word.startsWith("+"))) {
    excluded = word.startsWith("-");
    word = word.slice(1);
  }

  let editDistance: number | undefined;
  let boost: number | undefined;
  for (let i = 0; i < 2; i++) {
    const modifier = MODIFIER.exec(word);
    if (!modifier) break;
    if (modifier[1] === "~") {
      if (!Number.isInteger(Number(modifier[2]))) break;
      editDistance = Number(modifier[2]);
    } else {
      boost = Number(modifier[2]);
    }
    word = word.slice(0, modifier.index);
  }

  const prefix = word.endsWith("*");
  word = word.replace(/\*+$/, "");

  // Cut where the index cuts, so that `local-first` is `local` and `first`, in that order.
  const parts = normalizeSearchToken(word)
    .split(WORD_SEPARATOR)
    .map(trimSearchTerm)
    .filter(Boolean);
  if (parts.length === 0) return null;

  return {
    excluded,
    terms: parts.map((text, i) => ({
      text,
      prefix: prefix && i === parts.length - 1,
      ...(editDistance ? { editDistance } : {}),
      ...(boost ? { boost } : {}),
    })),
  };
}

/**
 * Parse a search query into the words and phrases it asks for. This is the only parser of query
 * text: the worker builds its Lunr query from the result and never hands the text to Lunr's own
 * (HVN-78), so `local-first` is the words `local` and `first`, `foo:bar` is a word with a colon
 * in it, and `c++ templates` is `c` and `templates`.
 *
 * A query with nothing to look for (only punctuation, or only words to leave out) comes back
 * with `problem` set, in words a reader can act on.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const { phrases, remainderParts } = splitQuotedSearchQuery(query);
  const required: QueryTerm[] = [];
  const excluded: string[] = [];
  const seen = new Set<string>();

  for (const rawWord of remainderParts.join(" ").split(/\s+/)) {
    const word = parseWord(rawWord);
    if (!word) continue;
    for (const term of word.terms) {
      const key = `${word.excluded ? "-" : ""}${JSON.stringify(term)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (word.excluded) excluded.push(term.text);
      else required.push(term);
    }
  }

  const terms = [
    ...new Set(required.filter((term) => !term.editDistance).map((term) => term.text)),
  ];
  const parsed: ParsedQuery = { phrases, terms, required, excluded };

  if (LEFT_OUT_PHRASE.test(query)) {
    // The minus would be dropped and the phrase required: the opposite of what was typed.
    parsed.problem = "Leaving out a phrase is not supported; use -word.";
  } else if (required.length === 0 && phrases.length === 0) {
    parsed.problem =
      excluded.length > 0
        ? "A search needs a word to look for, not only words to leave out."
        : "Type a word to search for.";
  }
  return parsed;
}
