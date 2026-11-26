/**
 * String passes over a message's HTML, run before DOMPurify sanitizes it. They are pure, so the
 * suite can test them (it has no DOM). DOMPurify still runs last, with its full configuration.
 */

import { foldText, foldWithMap } from "../services/searchFold";
import { splitScopedTerms } from "../services/searchQuery";

// A split on this gives the tags and comments at the odd indexes and the text between them at the
// even ones. A quoted attribute value may hold a `>`. marked escapes a `<` in text, so a `<` before
// a letter here opens a tag.
const TAG_OR_COMMENT = /(<!--[\s\S]*?-->|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>)/;

// One attribute inside a tag: its separator (whitespace or a slash, or the closing quote of the
// attribute before it), its name, and its value when it has one.
const ATTRIBUTE = /([\s/]+|(?<=["']))([^\s"'<>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Removes the event-handler attributes (`onerror`, `onclick`, ...) from the tags of a message.
 * DOMPurify removes them too, but it parses the string first, and that parse logs a CSP error for
 * each one even though nothing runs. Text, comments and the other attributes are left as they are.
 */
export function stripEventHandlers(html: string): string {
  return html
    .split(TAG_OR_COMMENT)
    .map((part, i) => {
      if (i % 2 === 0 || part.startsWith("<!--")) return part;
      return part.replace(ATTRIBUTE, (whole, _separator: string, name: string) =>
        /^on/i.test(name) ? "" : whole,
      );
    })
    .join("");
}

// An entity (`&amp;`, `&#39;`, `&#x2F;`) in a text part reads as one character, so a query must not
// match part of one: `amp` does not split `&amp;`.
const ENTITY = /(&(?:#\d+|#[xX][\da-fA-F]+|[a-zA-Z][a-zA-Z\d]*);)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]/g, "\\$&");
}

/**
 * The query's terms as the search index holds words: quoted phrases and single words, folded (lower
 * case, accents of Latin letters removed), longest first. The viewer finds them in the text the
 * way the index found them, so `cafe` marks `Café` and `istanbul` marks `İstanbul` (`searchFold.ts`).
 */
function foldedTerms(typed: string): string[] {
  const terms: string[] = [];
  // A `model:` or a `tag:` is looked for among the chat's labels, which are not in its text.
  const query = splitScopedTerms(typed).rest;

  // 1. Extract quoted phrases
  const quoteRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null = quoteRegex.exec(query);
  while (match !== null) {
    if (match[1].trim()) {
      terms.push(match[1].trim());
    }
    match = quoteRegex.exec(query);
  }

  // Remove quoted parts to process the rest
  const queryWithoutQuotes = query.replace(quoteRegex, " ");

  // 2. Process remaining terms: take the operators off, keep the words (`~2` and `^3` with them)
  const cleaned = queryWithoutQuotes
    .replace(/[~^]\d+(?:\.\d+)?/g, " ")
    .replace(/[+\-~*^:()]/g, " ")
    .trim();

  terms.push(...cleaned.split(/\s+/).filter(Boolean));

  // Longest first, so that a phrase is matched before the words in it
  return [...new Set(terms.map(foldText).filter(Boolean))].sort((a, b) => b.length - a.length);
}

/** `text` with each match of `pattern` (made for folded text) wrapped, as the text spells it. */
function wrapMatches(text: string, pattern: RegExp): string {
  const { folded, starts, ends } = foldWithMap(text);
  let out = "";
  let cursor = 0;
  for (const match of folded.matchAll(pattern)) {
    if (match[0].length === 0) continue;
    const from = starts[match.index ?? 0];
    // An accent that was folded away belongs to the letter before it, so the mark takes it too.
    const matched = ends[(match.index ?? 0) + match[0].length - 1];
    const to = matched + (/^[\u0300-\u036f]*/.exec(text.slice(matched))?.[0].length ?? 0);
    if (from < cursor) continue;
    out += `${text.slice(cursor, from)}<span class="highlight">${text.slice(from, to)}</span>`;
    cursor = to;
  }
  return out + text.slice(cursor);
}

/**
 * Wraps each word or phrase of the query in a `highlight` span, in the text of the HTML only. A
 * tag, an attribute value and a comment are left as they are, so a query such as `https` cannot
 * break a link, and an entity is not matched. Case and the accents of Latin letters do not matter,
 * as in the search. DOMPurify still runs after this.
 */
export function highlightTerms(html: string, query: string): string {
  const terms = foldedTerms(query);
  if (terms.length === 0) return html;
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "g");
  return html
    .split(TAG_OR_COMMENT)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(ENTITY)
        .map((piece, j) => (j % 2 === 1 ? piece : wrapMatches(piece, pattern)))
        .join("");
    })
    .join("");
}
