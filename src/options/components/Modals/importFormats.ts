/**
 * Which import formats the Import dialog lists under its filter (HVN-111). The filter is the format
 * the Providers view opened the dialog on. With no filter the dialog lists every format. With one,
 * it lists the formats of that format's own provider, compared whole: "claude_zip" and
 * "claudecode_jsonl" are two providers, though one name starts with the other.
 */

/** The provider a format belongs to: its name up to the first underscore. */
export function providerOfFormat(format: string): string {
  const cut = format.indexOf("_");
  return cut < 0 ? format : format.slice(0, cut);
}

/** True when the Import dialog lists `format` under `filter` (null: no filter, every format). */
export function formatListedUnder(filter: string | null, format: string): boolean {
  return !filter || providerOfFormat(filter) === providerOfFormat(format);
}
