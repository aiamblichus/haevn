import { escapeHtml } from "./html";

const MARK_OPEN =
  '<mark style="background-color: rgba(212, 175, 55, 0.3); padding: 0 2px; border-radius: 2px; box-shadow: 0 0 8px rgba(212, 175, 55, 0.4);">';

/**
 * Turn a search snippet into HTML for the archive: the snippet is raw conversation text, so it is
 * escaped first, and only then are the `{{HIGHLIGHT}}` markers (which contain no HTML-special
 * characters) turned into `<mark>`. The CLI reads the same snippet as text, so the worker never
 * escapes it.
 */
export function snippetToHtml(snippet: string | undefined): string {
  return escapeHtml(snippet || "")
    .replace(/\{\{HIGHLIGHT\}\}/g, MARK_OPEN)
    .replace(/\{\{\/HIGHLIGHT\}\}/g, "</mark>");
}
