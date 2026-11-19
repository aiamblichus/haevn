/**
 * The noun for a count: "1 chat", "2 chats". Callers write the count themselves, so a singular
 * count reads right in every place it is shown. Pass the plural when it is not the singular with an
 * "s" ("batch" takes "batches").
 */
export function pluralNoun(
  count: number,
  singular: string,
  plural: string = `${singular}s`,
): string {
  return count === 1 ? singular : plural;
}
