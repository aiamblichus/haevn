/**
 * String passes over a message's HTML, run before DOMPurify sanitizes it. They are pure, so the
 * suite can test them (it has no DOM). DOMPurify still runs last, with its full configuration.
 */

// A split on this gives the tags and comments at the odd indexes and the text between them at the
// even ones. A quoted attribute value may hold a `>`. marked escapes a `<` in text, so a `<` before
// a letter here opens a tag.
const TAG_OR_COMMENT = /(<!--[\s\S]*?-->|<\/?[a-zA-Z](?:[^<>"']|"[^"]*"|'[^']*')*>)/;

// One attribute inside a tag: its separator (whitespace or a slash, or the closing quote of the
// attribute before it), its name, and its value when it has one.
const ATTRIBUTE = /([\s/]+|(?<=["']))([^\s"'<>/=]+)(\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/**
 * Removes the event-handler attributes (`onerror`, `onclick`, ...) from the tags of a message.
 * DOMPurify removes them too, but it parses the string first, and that parse logs a CSP error for
 * each one even though nothing runs. Text, comments and the other attributes are left as they are.
 */
export function stripEventHandlers(html: string): string {
  return html
    .split(TAG_OR_COMMENT)
    .map((part, i) => {
      if (i % 2 === 0 || part.startsWith("<!--")) return part;
      return part.replace(ATTRIBUTE, (whole, _separator: string, name: string) =>
        /^on/i.test(name) ? "" : whole,
      );
    })
    .join("");
}
