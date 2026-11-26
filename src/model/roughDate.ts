// A date that is known only roughly (HVN-163): "2024", "March 2024", "between Nov 2023 and Feb 2024".
//
// `Chat.timestamp` must be an exact number, so a chat with a rough date carries the claim in
// `params.roughDate` and a `timestamp` at the middle of the range, for sorting. Any chat may carry
// the key; the readers look for the key, not for the provider. Only fragments write it today.

export type RoughPrecision = "year" | "month" | "day" | "range" | "after" | "unknown";

export interface RoughDate {
  /** The date as the person wrote it (`~2024-03`, `2023-11..2024-02`). Empty when none was given. */
  text: string;
  precision: RoughPrecision;
  /** The person marked it with `~`: about then. It changes the label only, not the range. */
  approximate: boolean;
  /** Start of the range, inclusive, in ms. 0 for `unknown`. */
  from: number;
  /** End of the range, exclusive, in ms. `null` for `after` and for no other precision. */
  to: number | null;
}

const PRECISIONS: ReadonlySet<string> = new Set([
  "year",
  "month",
  "day",
  "range",
  "after",
  "unknown",
]);

/** What a reader of a chat needs: the full `Chat`, or a list row that carries `params`. */
export interface HasParams {
  params?: Record<string, unknown>;
}

/** The rough date a chat carries, or undefined for a chat that has none (or a malformed one). */
export function roughDateOf(chat: HasParams | undefined): RoughDate | undefined {
  const value = chat?.params?.roughDate;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<RoughDate>;
  if (typeof candidate.precision !== "string" || !PRECISIONS.has(candidate.precision)) {
    return undefined;
  }
  if (typeof candidate.from !== "number" || !Number.isFinite(candidate.from)) return undefined;
  if (
    candidate.to !== null &&
    (typeof candidate.to !== "number" || !Number.isFinite(candidate.to))
  ) {
    return undefined;
  }
  return {
    text: typeof candidate.text === "string" ? candidate.text : "",
    precision: candidate.precision as RoughPrecision,
    approximate: candidate.approximate === true,
    from: candidate.from,
    to: candidate.to,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function year(ms: number): string {
  return String(new Date(ms).getUTCFullYear());
}

function month(ms: number): string {
  return `${MONTHS[new Date(ms).getUTCMonth()]} ${year(ms)}`;
}

function day(ms: number): string {
  return `${new Date(ms).getUTCDate()} ${month(ms)}`;
}

const RANGE_END = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/;

/** One end of a range, in the form the person wrote it ("2024", "2024-03", "2024-03-15"). */
function endLabel(token: string): string | undefined {
  const match = RANGE_END.exec(token.trim());
  if (!match) return undefined;
  const [, y, m, d] = match;
  const monthName = m ? MONTHS[Number(m) - 1] : undefined;
  if (m && !monthName) return undefined;
  if (d) return `${Number(d)} ${monthName} ${y}`;
  if (monthName) return `${monthName} ${y}`;
  return y;
}

/** "2024", "Mar 2024", "15 Mar 2024", "Nov 2023 to Feb 2024", "c. Mar 2024", "Mar 2024 or later", "undated". */
export function formatRoughDate(date: RoughDate): string {
  const text = date.text.replace(/^~/, "").trim();
  let label: string;
  switch (date.precision) {
    case "unknown":
      return "undated";
    case "year":
      label = year(date.from);
      break;
    case "month":
      label = month(date.from);
      break;
    case "day":
      label = day(date.from);
      break;
    case "after": {
      const start = endLabel(text.replace(/\.\.$/, ""));
      label = `${start ?? day(date.from)} or later`;
      break;
    }
    case "range": {
      const [first = "", last = ""] = text.split("..");
      const from = endLabel(first) ?? day(date.from);
      const to = endLabel(last) ?? day((date.to ?? date.from + 1) - 1);
      label = `${from} to ${to}`;
      break;
    }
  }
  return date.approximate ? `c. ${label}` : label;
}

/** The label of the rough date a chat carries, or undefined for a chat that has none. */
export function roughDateLabelOf(chat: HasParams | undefined): string | undefined {
  const rough = roughDateOf(chat);
  return rough ? formatRoughDate(rough) : undefined;
}

/**
 * The time fields of a search result. A chat with a rough date gives its label and no message time,
 * since the times of its messages are only there to keep their order (HVN-163).
 */
export function whenOf(
  chat: HasParams,
  messageTimestamp: number | undefined,
): { messageTimestamp?: number; dateLabel?: string } {
  const dateLabel = roughDateLabelOf(chat);
  return dateLabel ? { dateLabel } : { messageTimestamp };
}

/** The plain form of an exact time: what the archive has always shown. */
function formatTime(ts?: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

/**
 * The date of a chat for a list or a card. A chat with a rough date shows it as the person gave
 * it; any other shows the time it always showed: when the provider says it changed, else when it
 * was synced.
 */
export function formatChatDate(
  chat: HasParams & { providerLastModifiedTimestamp?: number; lastSyncedTimestamp?: number },
): string {
  const rough = roughDateOf(chat);
  if (rough) return formatRoughDate(rough);
  return formatTime(chat.providerLastModifiedTimestamp ?? chat.lastSyncedTimestamp);
}
