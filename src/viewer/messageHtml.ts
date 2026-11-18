/**
 * String passes over a message's HTML, run before DOMPurify sanitizes it. They are pure, so the
 * suite can test them (it has no DOM). DOMPurify still runs last, with its full configuration.
 */

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

/** The pattern for the query's terms: quoted phrases and single words, longest first. */
function termPattern(query: string): RegExp | null {
  const terms: string[] = [];

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

  // 2. Process remaining terms (standard Lunr-like cleanup)
  // Strip Lunr operators but keep the text
  const cleaned = queryWithoutQuotes.replace(/[+\-~*^:()]/g, " ").trim();

  const singleTerms = cleaned.split(/\s+/).filter(Boolean);
  terms.push(...singleTerms);

  if (terms.length === 0) return null;

  // Sort terms by length (longest first) to ensure longer phrases are matched before shorter sub-terms
  terms.sort((a, b) => b.length - a.length);

  const escapedTerms = terms.map(escapeRegExp);
  return new RegExp(`(${escapedTerms.join("|")})`, "gi");
}

/**
 * Wraps each word or phrase of the query in a `highlight` span, in the text of the HTML only. A
 * tag, an attribute value and a comment are left as they are, so a query such as `https` cannot
 * break a link, and an entity is not matched. DOMPurify still runs after this.
 */
export function highlightTerms(html: string, query: string): string {
  const pattern = termPattern(query);
  if (!pattern) return html;
  return html
    .split(TAG_OR_COMMENT)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part
        .split(ENTITY)
        .map((piece, j) =>
          j % 2 === 1 ? piece : piece.replace(pattern, '<span class="highlight">$1</span>'),
        )
        .join("");
    })
    .join("");
}
