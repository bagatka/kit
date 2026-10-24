// What `scrubText` recognizes is a closed list (README, "Recognizes"); whatever isn't on it is left
// as it is, by contract. Private keys go first, so their base64 goes whole; then keys and tokens by
// their shapes; then secrets by where they stand and by their names; then emails and card numbers.
//
// Guarantees, for any input: time linear in its length, because a pattern starts only where a run
// of what it reads starts (or at something rare, such as `://` or `password`) and reads a bounded
// amount from any other start; every repetition is bounded or one character class, and no group
// repeats inside a lookahead or lookbehind, since engines keep state for each such repetition and,
// past a few million characters, V8 throws and JavaScriptCore stops matching; and scrubbing twice
// changes nothing, since no marker (`[token]`) can start or end a new match.

// Right after an escape, where text starts again: `\n`, `\r` or `\t` in JSON, `%3D` in a URL.
const afterEscape = String.raw`(?<=\\[nrt]|%[0-9A-Fa-f]{2})`

// Where a key may start: not inside a run of the characters keys are made of.
const keyStart = String.raw`(?:(?<![A-Za-z0-9_-])|${afterEscape})`

const privateKeyLine = (word: string) => String.raw`-----${word} [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,10}-----`
// A PEM private key, through its END line, or to the end of its base64 when the text was cut short.
const privateKey = new RegExp(
  String.raw`${privateKeyLine("BEGIN")}[A-Za-z0-9+/=\s\\]*(?:${privateKeyLine("END")})?`,
  "g",
)

// Keys by their published prefixes, and JWTs: a JSON header (`ey...`) with a capital or a digit, so
// dotted words stay, claims, and a signature that may be empty. Each takes its whole run, or none,
// so a key glued after it is found in the same scrub.
const keyShapes = [
  String.raw`ey(?=[a-z_-]*[A-Z0-9])[A-Za-z0-9_-]{8}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{2}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*`,
  String.raw`(?:(?:sk|rk)_(?:live|test)|whsec)_[A-Za-z0-9]{10}[A-Za-z0-9]*`, // Stripe
  String.raw`sk-[A-Za-z0-9_-]{20}[A-Za-z0-9_-]*`, // OpenAI, Anthropic
  String.raw`(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20}[A-Za-z0-9_]*`, // GitHub
  String.raw`A(?:KI|SI)A[0-9A-Z]{16}(?![A-Za-z0-9])`, // AWS access key IDs
  String.raw`(?:xox[a-z]|xapp)-[A-Za-z0-9-]{10}[A-Za-z0-9-]*`, // Slack
  String.raw`AIza[A-Za-z0-9_-]{35}[A-Za-z0-9_-]*`, // Google API keys
]
const keys = new RegExp(`${keyStart}(?:${keyShapes.join("|")})`, "g")

// What follows a caller's own prefix: 16 key characters or more, but not `/`, so a link to a host
// the prefix also names stays.
const keyBody = "[A-Za-z0-9._~+=-]{16}[A-Za-z0-9._~+=-]*"

// At most 100 prefixes of 1 to 100 characters are taken, so their pattern always compiles.
const prefixLimit = 100

// The pattern of the last set of prefixes, by its text, so a caller that passes the same set each
// time compiles it once.
const lastPrefixPattern = new Map<string, RegExp>()

const ownKeys = (prefixes: ReadonlyArray<string> | undefined): ReadonlyArray<RegExp> => {
  const given: ReadonlyArray<unknown> = Array.isArray(prefixes) ? prefixes : []
  const usable = [
    ...new Set(given.filter((p): p is string => typeof p === "string" && p.length > 0 && p.length <= prefixLimit)),
  ].slice(0, prefixLimit)
  const key = usable.join("\n")
  const cached = lastPrefixPattern.get(key)
  if (usable.length === 0 || cached !== undefined) {
    return cached === undefined ? [] : [cached]
  }
  // Each prefix is matched as written, never as a pattern.
  const literal = usable.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&"))
  const pattern = new RegExp(`${keyStart}(?:${literal.join("|")})${keyBody}`, "g")
  lastPrefixPattern.clear()
  lastPrefixPattern.set(key, pattern)
  return [pattern]
}

// The password in `scheme://user:password@host`, up to the `@` that starts the host; never a port
// (`localhost:3000/users/@me`), nor the `:` of another `://`.
const urlPassword =
  /(?<=[A-Za-z0-9])(:\/\/[^\s:/?#@"']*:(?!\/\/))(?![0-9]{1,5}(?:[/?#\s"']|$))[^\s?#@"'\\]{1,128}(?=@)/g

// A scheme: a word (`Bearer`, `ApiKey`) or words joined by dashes (`AWS4-HMAC-SHA256`). A key, with
// digits and no dash, isn't one.
const scheme = String.raw`(?:[A-Za-z]{1,40}|[A-Za-z][A-Za-z0-9]{0,15}-[A-Za-z0-9-]{1,30})`

// An Authorization header's value: whatever follows the scheme, or the whole value, to a space, a
// quote, or a `&`, `,` or `;` after it.
const authorization = new RegExp(
  String.raw`(authorization["']?[ \t]*[:=][ \t]*["']?(?:${scheme}(?:[ \t]+|%20|\+))?)[^\s"'\\&,;]+`,
  "gi",
)

// A Cookie or Set-Cookie header's value, to the end of the line.
const cookie = /((?<![A-Za-z0-9])(?:set-)?cookie[ \t]*:[ \t]*)[^\s][^\r\n]*/gi

// What a credential is written with: base64(url), hex, `%XX`, and `|` or `:` joining two parts.
const credential = "[A-Za-z0-9._~+/=%|:-]"

// A word of prose, perhaps capitalized, joined, or ending a sentence: "signature", "re-issued.".
// One bounded class, since a repeated group inside the lookahead that refuses it would stop
// JavaScriptCore.
const prose = String.raw`[A-Za-z][a-z_-]{0,40}(?<![_-])`
const notProse = String.raw`(?!${prose}[.:]{0,8}(?!${credential}))`
// In a form-encoded query, where `+` or `%20` ends a word: `Token+expired+after+3600`.
const notEncodedProse = String.raw`(?!${prose}(?:[.:]{0,8}(?!${credential})|\+|%))`

// A parameter rather than a credential: `realm="api"` after `Bearer`, `user_id=42` after "token".
const notParameter = String.raw`(?![A-Za-z_][A-Za-z0-9_.-]{0,40}=[^\s=,;])`

// A credential after `Bearer`, `Basic` or `Token` (in their three spellings) elsewhere than a
// header, after any space but a line break, unless it is a word of prose or a parameter.
const schemeCredential = new RegExp(
  String.raw`(?:\b|${afterEscape})(Bearer|bearer|BEARER|Basic|basic|BASIC|Token|token|TOKEN)` +
    String.raw`((?:[^\S\r\n]+${notProse}|(?:%20|\+)${notEncodedProse})${notParameter})(${credential}{4}${credential}*)`,
  "g",
)

// What base64 and hex have and short words don't: a digit, padding, or both cases.
const credentialLike = /[0-9=]|[a-z].*[A-Z]|[A-Z].*[a-z]/

// A credential is 8 characters or more, or 4 or more that look like base64.
const replaceSchemeCredential = (match: string, name: string, space: string, value: string): string =>
  value.length >= 8 || credentialLike.test(value) ? `${name}${space}[token]` : match

// Query, fragment and `;` parameters whose values are secrets, also in a URL encoded into another.
// A value never starts on a marker (`[secret]`), so a second scrub can't take more than the first.
const secretParameter =
  /((?:[?&#;]|%(?:3F|26|23|3B))(?:(?:access|refresh|id)_?token|token|code|password|secret|client_secret|api_key|key|sig|signature|session|x-amz-(?:signature|credential|security-token))(?:=|%3D))(?!\[)[^&#;\s"'\\]+/gi

// The words that end a credential's name, for `isSecretName` and for named values in text. In
// text, `token`'s value goes only when it looks like one, and `authorization` has its own pattern.
const valueNames = String.raw`passwords?|passwd|pwd|passphrase|secrets?|credentials?|jwt|signature|session[_-]?id|connection[_-]?string|cookies?|(?:api|access|secret|private|signing|encryption|master)[_-]?key`
const secretName = new RegExp(String.raw`(?:^|[._-])(?:${valueNames}|token|authorization)$`, "i")

// The end of a name and what stands between it and its value: `password=`, `password: `,
// `"password": "`, and the same inside a JSON string (`\"password\":\"`).
const pairHead = (names: string) => String.raw`(?:${names})(?:\\?["'])?[ \t]*(?:=(?!>)|:(?!=))[ \t]*(?:\\?["'])?`

// A named secret's value: in quotes, to the closing quote; bare, to the next space or separator,
// unless it is only a literal (`null`) or a structure (`{`, `[`).
const secretPair = new RegExp(
  String.raw`(${pairHead(valueNames)})(?:(?<=\\")[^"\\\r\n]+|(?<=(?<!\\)")(?=[^"\r\n])[^"\\\r\n]*(?:\\[^\r\n][^"\\\r\n]*){0,256}|` +
    String.raw`(?<=')[^'\r\n]+|(?<![\\"'])(?!(?:null|true|false|undefined|None|nil)(?:[\s,;&})\]]|$))[^\s"'\\,;&{[=][^\s"'\\,;&]*)`,
  "gi",
)

// A token's value: 8 characters or more, not a word (`token: expired`).
const tokenPair = new RegExp(String.raw`(${pairHead("token")})${notProse}${credential}{8}${credential}*`, "gi")

// An address: 64 characters before the `@` (`%40` in a URL), 253 after it, and a top-level domain
// that isn't an image's extension (`logo@2x.png`). It starts where a run of what it reads starts,
// after an escape, or after a top-level domain and `_` or `-`, so glued addresses go in one scrub.
const local = "[A-Za-z0-9._%+-]"
const email = new RegExp(
  String.raw`(?:(?<![A-Za-z0-9._%+\\-])${local}{1,64}|(?<=\.[A-Za-z]{2,63}[_-])${local}{1,64}|${afterEscape}[A-Za-z0-9._+-]{1,64})` +
    String.raw`(?:@|%40)[A-Za-z0-9.-]{1,253}\.(?!(?:png|jpe?g|gif|webp|svg)(?![A-Za-z]))[A-Za-z]{2,63}(?![A-Za-z])`,
  "g",
)

// 13 to 19 digits starting with 2 to 6 (the card networks' ranges), together or in four groups of
// four separated alike by one space or dash; never after a decimal point (or `[card].`).
const card =
  /(?:(?<![A-Za-z0-9])(?<![0-9]\.)(?<!\[card\]\.)|(?<=\\[nrt]|%[0-9A-Fa-f]{2}))[2-6][0-9]{3}(?:[0-9]{9,15}|([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{4})(?![A-Za-z0-9])/g

// A card number passes the Luhn checksum and isn't one digit repeated.
const replaceCard = (match: string): string => {
  const digits = match.replace(/[ -]/g, "")
  let sum = 0
  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index])
    const doubled = index % 2 === 1 ? digit * 2 : digit
    sum += doubled > 9 ? doubled - 9 : doubled
  }
  return sum % 10 === 0 && !/^(.)\1+$/.test(digits) ? "[card]" : match
}

/**
 * `text` without the credentials and personal data on a closed list (README, "Recognizes"): keys
 * and tokens become `[token]`, named secrets, URL passwords, cookies and secret parameters
 * `[secret]`, emails `[email]`, card numbers `[card]`. Anything not on the list is left as it is,
 * by contract: the caller accepts that a secret in another form passes through.
 *
 * `ownKeyPrefixes` are prefixes of the caller's own keys (`["acme_live_"]`): a prefix followed by
 * 16 or more key characters is a token. At most 100 prefixes of 1 to 100 characters are taken, and
 * the last set's pattern is kept, so passing the same set each time compiles it once.
 *
 * Never throws; takes time linear in the text's length, whatever the text is made of, and keeps
 * scrubbing past runs of millions of characters on V8 and JavaScriptCore; scrubbing the result
 * again changes nothing. What isn't a string (from a JavaScript caller) is returned as `""`,
 * without calling into it.
 */
export const scrubText = (text: string, ownKeyPrefixes?: ReadonlyArray<string>): string => {
  const given: unknown = text
  if (typeof given !== "string") {
    return ""
  }
  const withoutSecrets = [privateKey, keys, ...ownKeys(ownKeyPrefixes)]
    .reduce((scrubbed, pattern) => scrubbed.replace(pattern, "[token]"), given)
    .replace(urlPassword, "$1[secret]")
    .replace(authorization, "$1[token]")
    .replace(cookie, "$1[secret]")
    .replace(schemeCredential, replaceSchemeCredential)
    .replace(secretParameter, "$1[secret]")
    .replace(secretPair, "$1[secret]")
    .replace(tokenPair, "$1[secret]")
  // The search for emails tries every word, so it runs only on text with an `@` (or `%40`).
  const withoutEmails = /@|%40/.test(withoutSecrets) ? withoutSecrets.replace(email, "[email]") : withoutSecrets
  return withoutEmails.replace(card, replaceCard)
}

/**
 * Whether a value named `name` is a credential whatever it looks like: a name ending with a word on
 * the list (`password`, `secret`, `token`, `api_key`, `authorization`, `cookie`, ...), after `.`,
 * `_`, `-` or a lower-case letter (`http.request.header.authorization`, `clientSecret`). Counts of
 * tokens (`max_tokens`) aren't. What isn't a string isn't a secret name.
 */
export const isSecretName = (name: string): boolean => {
  const given: unknown = name
  return typeof given === "string" && secretName.test(given.replace(/([a-z0-9])(?=[A-Z])/g, "$1_"))
}
