// Everything but printable ASCII, and the quote and backslash that delimit a quoted text.
const notPlainAscii = /[^\x20-\x7e]/gu
const quoteOrNotPlainAscii = /["\\]|[^\x20-\x7e]/gu

const shortEscapes: ReadonlyMap<string, string> = new Map([
  ['"', '\\"'],
  ["\\", "\\\\"],
  ["\n", "\\n"],
])

// `\u` and four lowercase hex digits for each UTF-16 code unit, as JSON writes them.
const escape = (match: string): string =>
  shortEscapes.get(match) ??
  match
    .split("")
    .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
    .join("")

/**
 * `text` in double quotes, as a JSON string literal whose quotes, backslashes, and every character
 * outside printable ASCII are escaped: `"a\n::error::b"`. For text from a `package.json` put into a
 * message, so it can't add a line to a log or color a terminal, and two different texts never print
 * alike. Linear in `text`'s length.
 */
export const quoted = (text: string): string => `"${text.replaceAll(quoteOrNotPlainAscii, escape)}"`

/** `text` with every character outside printable ASCII escaped, for another library's message. */
export const escaped = (text: string): string => text.replaceAll(notPlainAscii, escape)
