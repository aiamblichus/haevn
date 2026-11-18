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
