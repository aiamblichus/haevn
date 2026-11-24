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

/**
 * The text a flag was typed with, for `parseWholeNumber`. citty takes a value that starts with `-`
 * as a flag of its own, so `--offset -1` arrives as `--offset` with an empty value, and the `-1` as
 * a flag named `1`. The token is still in `rawArgs`: it is read from there, so `--offset -1` is
 * refused as `--offset=-1` is. Otherwise the parsed value stands (undefined when the flag is absent).
 */
export function flagText(
  parsed: string | undefined,
  rawArgs: readonly string[] | undefined,
  names: readonly string[],
): string | undefined {
  const raw = rawArgs ?? [];
  for (let i = 0; i < raw.length - 1; i++) {
    if (names.includes(raw[i]) && raw[i + 1].startsWith("-")) return raw[i + 1];
  }
  return parsed;
}

/**
 * Every value of a flag that may be given more than once (`--chat a --chat b`, or `--chat=a`), in the
 * order typed, read from the raw arguments: the parser keeps one value, and takes a value that
 * starts with `-` for a flag. A flag typed last with no value is an error, not an empty list.
 */
export function repeatedFlag(
  rawArgs: readonly string[] | undefined,
  names: readonly string[],
): string[] {
  const raw = rawArgs ?? [];
  const values: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i];
    const joined = names.find((name) => token.startsWith(`${name}=`));
    if (joined !== undefined) {
      values.push(token.slice(joined.length + 1));
    } else if (names.includes(token)) {
      if (i + 1 >= raw.length) throw new Error(`${token} needs a value.`);
      values.push(raw[++i]);
    }
  }
  if (values.some((value) => value === "")) throw new Error(`${names[0]} needs a value.`);
  return values;
}
