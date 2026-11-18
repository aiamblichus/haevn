// Search snippets: a few windows of a message's text, centred on where the query matched, with
// every match inside a window marked `{{HIGHLIGHT}}…{{/HIGHLIGHT}}` (the archive turns the
// markers into <mark>, the CLI into bold yellow). Pure: the callers say where the matches are.

/** A span of the text, in UTF-16 code units as `String.prototype.slice` counts them. */
export interface TextRange {
  start: number;
  length: number;
}

export interface SnippetOptions {
  /** Characters kept on each side of a match: the `--context` of the CLI. */
  radius: number;
  /** Spans to mark inside the windows; defaults to the anchors. */
  marks?: TextRange[];
  /** Separate windows to show when the anchors lie far apart. */
  maxWindows?: number;
}

export const MAX_SNIPPET_WINDOWS = 3;

const OPEN = "{{HIGHLIGHT}}";
const CLOSE = "{{/HIGHLIGHT}}";
const ELLIPSIS = "...";

const NON_WORD_START = /^[^\p{L}\p{M}\p{N}_]+/u;
const NON_WORD_END = /[^\p{L}\p{M}\p{N}_]+$/u;
const PUNCTUATION_START = /^[\p{P}\p{Z}\p{Cc}]+/u;
const PUNCTUATION_END = /[\p{P}\p{Z}\p{Cc}]+$/u;

/**
 * Where the word is inside a token: `[start, end)` in UTF-16 units, without the characters that
 * are not letters, combining marks, digits or "_" (a mark ends many words in Hindi or Thai, and a
 * decomposed "é"). A token with no such character ("😀,", "++") keeps its symbols and loses only
 * punctuation and spaces; one that is all punctuation ("!!!") is left whole. The index trims its
 * terms with this (`searchPipeline.ts`) and the snippet marks with it, so a mark lands on what
 * the search matched.
 */
export function wordBounds(token: string): { start: number; end: number } {
  const strip = (lead: RegExp, trail: RegExp) => {
    const start = token.match(lead)?.[0].length ?? 0;
    const end = token.length - (token.match(trail)?.[0].length ?? 0);
    return start < end ? { start, end } : null;
  };
  return (
    strip(NON_WORD_START, NON_WORD_END) ??
    strip(PUNCTUATION_START, PUNCTUATION_END) ?? { start: 0, end: token.length }
  );
}

/**
 * `range` without the characters at either end that are not part of the word (`wordBounds`).
 * Lunr reports a match as the whole token it split off the text, so "pineapple," comes back with
 * its comma; the mark belongs on the word.
 */
export function trimToWord(text: string, range: TextRange): TextRange {
  const slice = text.slice(range.start, range.start + range.length);
  const { start, end } = wordBounds(slice);
  return { start: range.start + start, length: end - start };
}

/**
 * Lunr lower-cases the text before it splits it, so the positions it reports are in the
 * lower-cased text, and `"İ".toLowerCase()` is two code units ("i" and a combining dot): every İ
 * before a match moves the match one unit to the right of where the original text has it.
 * (U+0130 is the only character whose lower case has another length, and it is always longer.)
 *
 * Returns null when `text` has none, so its lower case is the same length and the positions are
 * the original's already. Otherwise returns a function that takes a range in the lower-cased text
 * to the range of the same characters in `text`. The table is built once, so call this once per
 * text and use the function for every match.
 */
export function lowerCaseRangeMapper(text: string): ((range: TextRange) => TextRange) | null {
  const lower = text.toLowerCase();
  if (lower.length === text.length) return null;

  // For each unit of the lower-cased text: where its character starts and ends in the original.
  const starts = new Uint32Array(lower.length);
  const ends = new Uint32Array(lower.length);
  let at = 0;
  for (let i = 0; i < text.length; ) {
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const width = text.slice(i, i + size).toLowerCase().length;
    for (let k = 0; k < width; k++) {
      starts[at + k] = i;
      ends[at + k] = i + size;
    }
    at += width;
    i += size;
  }

  return ({ start, length }) => {
    if (length <= 0 || start < 0 || start + length > lower.length) return { start, length };
    const from = starts[start];
    return { start: from, length: ends[start + length - 1] - from };
  };
}

/** Spans that lie inside the text, sorted, with overlapping and touching ones merged. */
function normalise(ranges: TextRange[], textLength: number): [number, number][] {
  const spans: [number, number][] = [];
  for (const { start, length } of ranges) {
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) continue;
    if (start < 0 || start >= textLength) continue;
    spans.push([start, Math.min(textLength, start + length)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * The snippet of `text` for the matches at `anchors`: a window of `radius` characters on each
 * side of the earliest anchor, and, when later anchors are further away than that, up to
 * `maxWindows` windows in all, in text order, joined with an ellipsis. Windows that meet are one.
 * The earliest anchor is always inside the first window. An ellipsis stands where the text is
 * cut off. Whitespace runs become single spaces. With no usable anchor, the snippet is the
 * start of the text.
 */
export function buildSnippet(text: string, anchors: TextRange[], options: SnippetOptions): string {
  if (!text) return "";
  const radius = Math.max(0, Math.floor(options.radius));
  const maxWindows = Math.max(1, options.maxWindows ?? MAX_SNIPPET_WINDOWS);

  const anchorSpans = normalise(anchors, text.length);
  const windows: [number, number][] = [];
  if (anchorSpans.length === 0) {
    windows.push([0, Math.min(text.length, 2 * radius)]);
  } else {
    for (const [start, end] of anchorSpans) {
      const from = Math.max(0, start - radius);
      const to = Math.min(text.length, end + radius);
      const last = windows[windows.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else if (windows.length < maxWindows) windows.push([from, to]);
      else break;
    }
  }

  // Do not cut an astral character (an emoji, a rare CJK ideograph) in half.
  for (const window of windows) {
    if (window[0] > 0 && isLowSurrogate(text.charCodeAt(window[0]))) window[0] -= 1;
    if (window[1] < text.length && isLowSurrogate(text.charCodeAt(window[1]))) {
      if (isHighSurrogate(text.charCodeAt(window[1] - 1))) window[1] += 1;
    }
  }

  const marks = normalise(options.marks ?? anchors, text.length);
  const pieces = windows.map(([from, to]) => {
    let out = "";
    let cursor = from;
    for (const [markStart, markEnd] of marks) {
      if (markEnd <= from) continue;
      if (markStart >= to) break;
      const start = Math.max(markStart, from);
      const end = Math.min(markEnd, to);
      out += text.slice(cursor, start) + OPEN + text.slice(start, end) + CLOSE;
      cursor = end;
    }
    out += text.slice(cursor, to);
    return out.replace(/\s+/g, " ").trim();
  });

  const first = windows[0];
  const last = windows[windows.length - 1];
  return (
    (first[0] > 0 ? `${ELLIPSIS} ` : "") +
    pieces.join(` ${ELLIPSIS} `) +
    (last[1] < text.length ? ` ${ELLIPSIS}` : "")
  );
}
