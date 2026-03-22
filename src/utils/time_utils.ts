/**
 * Time and date formatting utilities
 */

/**
 * Format a timestamp (milliseconds or ISO string) as a localized date/time string.
 * Accepts both number (milliseconds since epoch) and string (ISO format) inputs.
 *
 * @param timestamp - Timestamp as number (milliseconds) or ISO string
 * @returns Formatted date/time string in user's locale
 */
export function formatLocalTime(timestamp: number | string): string {
  try {
    // Normalize input: convert ISO string to milliseconds if needed
    const date = typeof timestamp === "number" ? new Date(timestamp) : new Date(timestamp);
    return date.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch (_error) {
    return new Date().toLocaleString();
  }
}
