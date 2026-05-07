export type ParsedQuery = {
  phrases: string[];
  terms: string[];
};

export function normalizeSearchToken(value: string): string {
  return value.trim().toLowerCase();
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

/**
 * Parse a search query into phrases (from "quoted" segments) and individual terms.
 * Strips Lunr operators, de-duplicates terms, and normalizes tokens to lowercase
 * so downstream matching remains case-insensitive.
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const { phrases, remainderParts } = splitQuotedSearchQuery(query);
  const cleaned = remainderParts.join(" ").replace(/[+\-~*^:"()]/g, " ");
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const rawTerm of cleaned.split(/\s+/)) {
    const normalized = normalizeSearchToken(rawTerm);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      terms.push(normalized);
    }
  }

  return { phrases, terms };
}
