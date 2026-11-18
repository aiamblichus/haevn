/**
 * Parse a whole-number flag. Returns `fallback` when the flag is absent; refuses anything that is
 * not a whole number of at least `min`, so a typo never turns into the daemon's silent default.
 */
export function parseWholeNumber(
  flag: string,
  input: string | undefined,
  fallback: number,
  min = 0,
): number {
  if (input == null || input === "") return fallback;
  const value = /^\d+$/.test(input) ? Number.parseInt(input, 10) : Number.NaN;
  if (!(value >= min)) {
    throw new Error(`--${flag} must be a whole number, ${min} or more (got "${input}").`);
  }
  return value;
}
