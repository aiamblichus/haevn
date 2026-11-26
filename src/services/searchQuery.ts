import type { LabelKind } from "./searchDocument";
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
};

/**
 * A word or phrase that must be (or, with `excluded`, must not be) a model or a tag of the chat:
 * `model:gpt-4o`, `-tag:draft`, `tag:"creative writing"`, `model:claude*`.
 */
export type ScopedTerm = {
  scope: LabelKind;
  /** The words as typed, lower case: a label row has them next to each other, in this order. */
  text: string;
  /** Typed `word*`: the last word may go on. */
  prefix: boolean;
  excluded: boolean;
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
  /** The `model:` and `tag:` parts: looked for among the chat's labels, not in its text. */
  scoped: ScopedTerm[];
  /** Why there is nothing to search for, when there is not. */
  problem?: string;
};

/**
 * Where a query cuts a word: at a hyphen, where the index splits (it indexes `local-first` as
 * `local` and `first`), and at a star inside the word, which the index does not hold (only a
 * trailing star means something).
 */
const WORD_SEPARATOR = /[-*]+/;

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

    // A star is a word break here as it is in a word (see parseWord): the index holds no star.
    const phrase = normalizeSearchToken((match[1] || "").replace(/\*+/g, " ").replace(/\s+/g, " "));
    if (phrase) phrases.push(phrase);

    lastIndex = quoteRegex.lastIndex;
    match = quoteRegex.exec(query);
  }

  const tail = query.slice(lastIndex).trim();
  if (tail) remainderParts.push(tail);

  return { phrases, remainderParts };
}

/** `model:` or `tag:` (or the plural, in any case), then its value: a quoted phrase or a word. */
const SCOPED_TERM = /(-?)(model|tag)s?:("[^"]+"|\S+)/iy;

/**
 * Take the `model:` and `tag:` parts out of a query. They are found only where a word starts and
 * outside quotes, so `"the model:x problem"` is still a phrase. What is left is the query without
 * them, in the same order.
 */
export function splitScopedTerms(query: string): { rest: string; scoped: ScopedTerm[] } {
  const scoped: ScopedTerm[] = [];
  let rest = "";
  let at = 0;
  while (at < query.length) {
    const char = query[at];
    if (char === '"') {
      const close = query.indexOf('"', at + 1);
      const end = close === -1 ? query.length : close + 1;
      rest += query.slice(at, end);
      at = end;
      continue;
    }
    if (at === 0 || /\s/.test(query[at - 1])) {
      SCOPED_TERM.lastIndex = at;
      const found = SCOPED_TERM.exec(query);
      if (found) {
        const value = found[3];
        // A quote still being typed (`tag:"creative`) is no phrase yet: the word is what follows it.
        const quoted = value.length > 1 && value.startsWith('"') && value.endsWith('"');
        const text = normalizeSearchToken(
          (quoted ? value.slice(1, -1) : value.replace(/^"+/, ""))
            .replace(/\*+/g, " ")
            .replace(/\s+/g, " "),
        );
        // A value with no letter or digit in it names nothing to look for.
        if (/[\p{L}\p{N}]/u.test(text)) {
          scoped.push({
            scope: found[2].toLowerCase() === "model" ? "model" : "tag",
            text,
            prefix: !quoted && value.endsWith("*"),
            excluded: found[1] === "-",
          });
        }
        rest += " ";
        at += found[0].length;
        continue;
      }
    }
    rest += char;
    at++;
  }
  return { rest, scoped };
}

/** The most edits `word~N` allows. */
const MAX_EDIT_DISTANCE = 2;

/** A minus that starts a word and is followed by a quote: `-"a phrase"`. */
const LEFT_OUT_PHRASE = /(?:^|\s)-"/;

/** `foo~2^3` or `foo^3~2`: the modifiers at the end of a word, whichever order they come in. */
const MODIFIER = /([~^])(\d+(?:\.\d+)?)$/;

type ParsedWord = { excluded: boolean; terms: QueryTerm[] };

/**
 * One whitespace-separated word of the query. The operators are the ones the CLI documents: a
 * leading `-` leaves the word out, a trailing `*` makes it a prefix and `~N` allows N edits.
 * `^N` is accepted and ignored: it boosted one word in Lunr, and the index that ranks the chats
 * now scores a whole query, not a word of it. Nothing else is an operator: a colon, a plus or a
 * bracket is a character like the others, and the edges of the word are trimmed the way the
 * index trims the words of the text.
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
  for (let i = 0; i < 2; i++) {
    const modifier = MODIFIER.exec(word);
    if (!modifier) break;
    if (modifier[1] === "~") {
      if (!Number.isInteger(Number(modifier[2]))) break;
      // The cost of the expansion grows steeply with the distance, and by 3 a word matches
      // almost any other.
      editDistance = Math.min(Number(modifier[2]), MAX_EDIT_DISTANCE);
    }
    word = word.slice(0, modifier.index);
  }

  const prefix = word.endsWith("*");
  word = word.replace(/\*+$/, "");

  // Cut where the index cuts, so that `local-first` is `local` and `first`, in that order. A
  // star inside the word cuts it too: only a trailing star is a prefix.
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
    })),
  };
}

/**
 * Most words and phrases a query may have. The index joins one lookup for each, and SQLite stops
 * at 500 of them in one statement; a pasted paragraph is not a search anyone means.
 */
export const MAX_QUERY_CLAUSES = 100;

/**
 * Parse a search query into the words and phrases it asks for. This is the only parser of query
 * text: the worker builds its index query from the result and never hands the typed text to the
 * index (HVN-78), so `local-first` is the words `local` and `first`, `foo:bar` is a word with a colon
 * in it, and `c++ templates` is `c` and `templates`. The one colon that means something is
 * `model:` and `tag:` (HVN-164), which look among the chat's models and tags.
 *
 * A query with nothing to look for (only punctuation, or only words to leave out) comes back
 * with `problem` set, in words a reader can act on.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const { rest, scoped } = splitScopedTerms(query);
  const { phrases, remainderParts } = splitQuotedSearchQuery(rest);
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
  const parsed: ParsedQuery = { phrases, terms, required, excluded, scoped };
  const scopedRequired = scoped.filter((term) => !term.excluded).length;

  if (LEFT_OUT_PHRASE.test(rest)) {
    // The minus would be dropped and the phrase required: the opposite of what was typed.
    parsed.problem = "Leaving out a phrase is not supported; use -word.";
  } else if (required.length === 0 && phrases.length === 0 && scopedRequired === 0) {
    parsed.problem =
      excluded.length > 0 || scoped.length > 0
        ? "A search needs a word to look for, not only words to leave out."
        : "Type a word to search for.";
  } else if (
    required.length + phrases.length + excluded.length + scoped.length >
    MAX_QUERY_CLAUSES
  ) {
    parsed.problem = `That is more than ${MAX_QUERY_CLAUSES} words and phrases. Search for fewer of them.`;
  }
  return parsed;
}
