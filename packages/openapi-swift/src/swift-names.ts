// How the document's names and text become Swift's.

// Swift's keywords, as The Swift Programming Language lists them, which a name may use only in
// backticks; `Type` and `Protocol`, which mean a metatype after a dot; and contextual keywords.
const keywords = new Set([
  "Any",
  "Protocol",
  "Self",
  "Type",
  "actor",
  "any",
  "as",
  "associatedtype",
  "async",
  "await",
  "borrowing",
  "break",
  "case",
  "catch",
  "class",
  "consuming",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "false",
  "fileprivate",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "init",
  "inout",
  "internal",
  "is",
  "let",
  "nil",
  "nonisolated",
  "open",
  "operator",
  "precedencegroup",
  "private",
  "protocol",
  "public",
  "repeat",
  "rethrows",
  "return",
  "self",
  "some",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "true",
  "try",
  "typealias",
  "var",
  "where",
  "while",
])

const plainIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whether `name` is a Swift identifier as it is: letters, digits and `_`, not starting with a digit. */
export const isIdentifier = (name: string): boolean => plainIdentifier.test(name)

// What a raw identifier (Swift 6.2) may hold: printable ASCII, without a backtick or a backslash,
// and not only digits and operator characters.
const rawIdentifier = /^[\x20-\x7e]+$/

/**
 * `name` as Swift code: as it is, or in backticks when it is a keyword or, as a raw identifier, not
 * an identifier at all, such as `1m`. Undefined for text no Swift name can hold.
 */
export const swiftName = (name: string): string | undefined => {
  if (name === "_") {
    // The wildcard: Swift reads it as no name.
    return undefined
  }
  if (isIdentifier(name) && !keywords.has(name)) {
    return name
  }
  const holdable = rawIdentifier.test(name) && !/[`\\]/.test(name) && /[A-Za-z_]/.test(name) && name.trim() === name
  return holdable ? `\`${name}\`` : undefined
}

/** `phone.not_found` as `PhoneNotFound`: each word's first letter in capitals. */
export const pascalCase = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join("")

/** `PhoneNotFound` as `phoneNotFound`, `down` as `down`: the first letter in lowercase. */
export const camelCase = (text: string): string => {
  const pascal = pascalCase(text)
  return `${pascal.slice(0, 1).toLowerCase()}${pascal.slice(1)}`
}

/**
 * `text` as a Swift string literal: quotes and backslashes escaped, and every control character
 * written as its code, so no text can end the literal or the line.
 */
export const stringLiteral = (text: string): string => {
  const escaped = Array.from(text, (character) => {
    if (character === "\\" || character === '"') {
      return `\\${character}`
    }
    const code = character.codePointAt(0) ?? 0
    const isControl = code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029
    return isControl ? `\\u{${code.toString(16)}}` : character
  })
  return `"${escaped.join("")}"`
}

// Text for a comment: line breaks of every kind as `\n`, and every other control character as a
// space, so no text can end the comment's line and write code.
const commentText = (text: string): string =>
  Array.from(text.replaceAll("\r\n", "\n"), (character) => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x0d || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return "\n"
    }
    return code < 0x20 || code === 0x7f ? " " : character
  }).join("")

// A paragraph's words as lines of at most `width` characters; a longer word is a line of its own.
const wrap = (paragraph: string, width: number): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let line = ""
  for (const word of paragraph.split(/\s+/).filter((part) => part.length > 0)) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line === "" ? word : `${line} ${word}`
    }
  }
  return line === "" ? lines : [...lines, line]
}

/** `text` as `///` doc comment lines at `indent`, at most 100 characters each; paragraphs kept. */
export const docComment = (text: string, indent: string): string =>
  commentText(text)
    .split(/\n\s*\n/)
    .map((paragraph) => wrap(paragraph, 100 - indent.length - 4).map((line) => `${indent}/// ${line}`))
    .filter((lines) => lines.length > 0)
    .map((lines) => lines.join("\n"))
    .join(`\n${indent}///\n`)

/** `text` on one line, for a `//` comment or a sentence inside one. */
export const oneLine = (text: string): string => commentText(text).replaceAll(/\s+/g, " ").trim()
