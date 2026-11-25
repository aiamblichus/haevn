/**
 * What a log line may say about chat content: its shape, never the content (HVN-157).
 *
 * The logger keeps its entries in `chrome.storage` and `haevn logs` reads them from the terminal,
 * so a log line holds no message text, title, system prompt, search query, attachment file name,
 * or a provider's response or error body. Ids, counts, lengths, statuses and timings are fine.
 * These helpers turn a value into the words a log line may use for it.
 */

const MAX_NOTE_LENGTH = 200;
const MAX_KEYS = 12;

/** An identifier-like quoted word (a property name in a TypeError) is kept; other quotes are not. */
const KEEPABLE_QUOTED = /^[A-Za-z_$][\w$]{0,39}$/;

/**
 * Make an error message safe to put in a report or a log line: it must hold no chat id, no URL
 * (the path or query can carry an id), no quoted run of the payload (a JSON.parse error quotes
 * the text it choked on) and no long token (an organization id, a cursor).
 */
export function scrubMessage(message: string, knownIds: readonly string[] = []): string {
  let text = message;
  for (const id of knownIds) {
    if (id.length === 0) continue;
    for (const form of new Set([id, encodeURIComponent(id)])) {
      text = text.split(form).join("<id>");
    }
  }
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
  text = text.replace(/(['"`])((?:(?!\1).){0,400}?)\1/g, (whole, quote: string, inner: string) =>
    KEEPABLE_QUOTED.test(inner) ? whole : `${quote}…${quote}`,
  );
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>");
  text = text.replace(/[A-Za-z0-9_-]{20,}/g, "<id>");
  text = text.replace(/\s+/g, " ").trim();
  return text.length > MAX_NOTE_LENGTH ? `${text.slice(0, MAX_NOTE_LENGTH)}…` : text;
}

/** A text as its length: `34 chars`. */
export function charsOf(text: unknown): string {
  if (typeof text === "string") return `${text.length} chars`;
  return text === undefined || text === null ? "none" : `a ${typeof text}`;
}

/**
 * A value as its shape: `array of 12`, `object with keys a, b, c`, `34 chars`. Only the top-level
 * keys are named, and a key is a field name of the provider's payload, never the user's text.
 */
export function shapeOf(value: unknown): string {
  if (typeof value === "string") return charsOf(value);
  if (value === undefined || value === null) return "none";
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === "object") {
    const keys = Object.keys(value);
    const shown = keys.slice(0, MAX_KEYS).join(", ");
    return `object with keys ${shown}${keys.length > MAX_KEYS ? `, +${keys.length - MAX_KEYS}` : ""}`;
  }
  return `a ${typeof value}`;
}

/** A worker message as its type and shape: a message of a type nobody knows can hold anything. */
export function messageShape(message: unknown): string {
  const type =
    typeof message === "object" && message !== null && "type" in message
      ? String((message as { type: unknown }).type)
      : "no type";
  return `type ${type}, ${shapeOf(message)}`;
}

/** A file name as its extension and length: `.png, 18 chars`. */
export function fileNameShape(name: unknown): string {
  if (typeof name !== "string") return charsOf(name);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "no extension";
  return `${extension}, ${name.length} chars`;
}

/**
 * An error as its kind and the length of its message, for a failure whose message can quote the
 * search query or the text it was asked about (a SQLite syntax error does): the words are left out.
 */
export function errorKind(err: unknown): string {
  if (err instanceof Error) return `${err.name || "Error"} (${err.message.length} chars)`;
  return `a ${typeof err} (${String(err).length} chars)`;
}

/**
 * An error as a name and a scrubbed message, for a failure that can quote the text it choked on
 * (a JSON.parse error does) or the query it was asked.
 */
export function errorShape(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
    return `${name}${scrubMessage(err.message)}`;
  }
  return scrubMessage(String(err));
}
