// How the search index folds words, written in JavaScript for the places that cannot ask the
// index: the viewer's highlighting of a chat that is open, and the near-spelling expansion.
//
// The index is SQLite FTS5 with `unicode61 remove_diacritics 2`. That tokenizer lower-cases every
// letter and removes the accents of Latin letters and nothing else: `café` is `cafe`, `İstanbul`
// is `istanbul`, and `й` and `ё` stay what they are (a Russian reader means a different word by
// `еж` and `ёж`). This module folds a character the same way, one code point at a time, so that a
// mark in the viewer lands on what the index matched. `tests/searchFold.test.ts` compares it with
// the real tokenizer over the Latin, Greek and Cyrillic blocks, where it is exact. Beyond them it
// disagrees on 444 of the 74,957 letters, marks and digits up to U+1FFFF (measured by comparing
// every one): scripts whose case pairs are newer than SQLite's case table (Cherokee, Georgian
// Mtavruli, Latin Extended-D, Osage, Vithkuqi, Old Hungarian, Warang Citi, Medefaidrin, Adlam,
// Glagolitic, and four Cyrillic letters). They are lower-cased here and left alone there, so a
// mark in the viewer misses a word typed in the other case. The index itself is not affected.

const LATIN = /\p{Script=Latin}/u;
// The combining marks the tokenizer drops wherever they stand. It keeps the other marks of
// U+0300 to U+036F as part of the word, so `a` and U+0305 are one token, and this list is what
// was measured, not the block (`tests/searchFold.test.ts` compares it with the tokenizer).
const DROPPED_MARK =
  /[\u0300-\u0304\u0306-\u030c\u030f\u0311\u031b\u0323-\u0328\u032d\u032e\u0330\u0331]/;
const DROPPED_MARKS = new RegExp(DROPPED_MARK.source, "g");

// Letters whose fold is not `toLowerCase()` plus the accents above: the tokenizer folds the case
// of these by Unicode's simple case folding, and keeps two diacritics on a few letters.
const SPECIAL: Record<string, string> = {
  "\u00b5": "\u03bc", // micro sign to Greek mu
  "\u017f": "s", // long s
  "\u03c2": "\u03c3", // final sigma
  "\u03d0": "\u03b2",
  "\u03d1": "\u03b8",
  "\u03d5": "\u03c6",
  "\u03d6": "\u03c0",
  "\u03f0": "\u03ba",
  "\u03f1": "\u03c1",
  "\u03f5": "\u03b5",
  "\u037f": "\u037f", // capital yot: newer than the tokenizer's case table
  "\u01e0": "\u01e1",
  "\u01e1": "\u01e1",
  "\u01e2": "\u01e3",
  "\u01e3": "\u01e3",
  "\u01ee": "\u01ef",
  "\u01ef": "\u01ef",
  "\u01fc": "\u01fd",
  "\u01fd": "\u01fd",
  "\u01fe": "\u01ff",
  "\u01ff": "\u01ff",
};

const cache = new Map<string, string>();

/** One character folded: lower case, and for a Latin letter without its accents. */
function foldChar(char: string): string {
  const known = cache.get(char);
  if (known !== undefined) return known;
  let folded: string;
  if (DROPPED_MARK.test(char)) {
    folded = "";
  } else if (char in SPECIAL) {
    folded = SPECIAL[char];
  } else {
    const lower = char.toLowerCase();
    // `İ` is "i" and a combining dot in lower case; the dot goes with the other marks.
    folded = LATIN.test(char)
      ? lower.normalize("NFD").replace(DROPPED_MARKS, "").normalize("NFC")
      : lower.replace(DROPPED_MARKS, "");
  }
  if (cache.size < 4096) cache.set(char, folded);
  return folded;
}

/** `text` as the index holds it: lower case, accents of Latin letters removed. */
export function foldText(text: string): string {
  return foldWithMap(text).folded;
}

export interface FoldedText {
  folded: string;
  /** For each UTF-16 unit of `folded`: where the character it came from starts in the original. */
  starts: Uint32Array;
  /** ... and where it ends (exclusive). */
  ends: Uint32Array;
}

/**
 * `text` folded, with the way back: folding can change the length (`İ` has a lower case of two
 * units, an accent has none), so a match in the folded text is taken back to the original text
 * through `starts` and `ends`.
 */
export function foldWithMap(text: string): FoldedText {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; ) {
    const size = (text.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const piece = foldChar(text.slice(i, i + size));
    for (let k = 0; k < piece.length; k++) {
      starts.push(i);
      ends.push(i + size);
    }
    folded += piece;
    i += size;
  }
  return { folded, starts: Uint32Array.from(starts), ends: Uint32Array.from(ends) };
}
