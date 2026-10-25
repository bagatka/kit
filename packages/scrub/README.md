# @bagatka/scrub

Removes credentials and personal data from text before it is stored: tokens, keys, secrets in URLs,
emails, and card numbers.

## Install

```sh
npm install @bagatka/scrub
```

No dependencies. It runs in any JavaScript runtime with lookbehind in regular expressions.

## Use it

```ts
import { isSecretName, scrubText } from "@bagatka/scrub"

scrubText("Invite to anna@example.com failed: Bearer abcDEF1234567890")
// "Invite to [email] failed: Bearer [token]"
scrubText("GET /callback?code=4/0AY0e&state=x") // "GET /callback?code=[secret]&state=x"
scrubText("connect postgres://app:hunter2@db:5432/notes") // "connect postgres://app:[secret]@db:5432/notes"
scrubText('{"user":"bob","password":"hunter2"}') // '{"user":"bob","password":"[secret]"}'
scrubText("Charged 4242 4242 4242 4242") // "Charged [card]"

// Keys of your own product, by their prefixes.
scrubText("Refused acme_live_Zk3Pq9TzX2mV8wYb4LdR", ["acme_live_"]) // "Refused [token]"

// A value whose name says it is a credential is removed whole, whatever it looks like.
isSecretName("http.request.header.authorization") // true
isSecretName("gen_ai.usage.input_tokens") // false
```

## Contract

`src/index.ts`. `scrubText` removes what is on a closed list from text and leaves everything else as
it is; `isSecretName` says whether a named value is a credential. Neither throws.

## Recognizes

This list is the contract: what isn't on it is left as it is, and the caller accepts that a secret
written another way passes through.

- **`Authorization:` header values:** whatever follows the scheme (`Bearer`, `Basic`, `ApiKey`, a
  word or words joined by dashes), or the whole value, to a space, a quote, or `&`, `,` or `;`, as
  a header line, a JSON field (`"authorization": "..."`) or a parameter (`authorization=...`).
- **`Bearer`, `Basic` and `Token` credentials elsewhere,** in those three spellings, after a space
  (or `%20` or `+`): 8 characters or more, or 4 or more with a digit, `=` or both cases. A word of
  prose ("Invalid token signature", "Token expired: sign in again") or a parameter
  (`Bearer realm="api"`, "token user_id=42") after the scheme stays.
- **JWTs:** a base64url header starting `ey` with a capital or a digit, claims, and a signature that
  may be empty.
- **Keys by their published prefixes:** Stripe (`sk_` and `rk_` live and test, `whsec_`), OpenAI and
  Anthropic (`sk-`), GitHub (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), AWS access key
  IDs (`AKIA`, `ASIA`), Slack (`xox...-`, `xapp-`), Google API keys (`AIza`), npm (`npm_`), GitLab
  personal access tokens (`glpat-`), and the caller's own prefixes.
- **Secret query, fragment and `;` parameters by name:** `token`, `access_token`, `refresh_token`,
  `id_token`, `code`, `password`, `secret`, `client_secret`, `api_key`, `key`, `sig`, `signature`,
  `session`, `X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`, also in a URL encoded
  into another (`%3Ftoken%3D`).
- **The password in `scheme://user:password@host`,** up to the first `@` after it, however long;
  never a port (`localhost:3000/users/@me`).
- **Values of named secrets:** `name=value`, `name: value` and JSON's `"name": "value"` (also inside
  a JSON string, `\"name\":\"value\"`), where the name ends with a word `isSecretName` knows:
  `password`, `passwd`, `pwd`, `passphrase`, `secret`, `credentials`, `jwt`, `signature`,
  `session_id`, `connection_string`, `cookie`, an API, access, secret, private, signing, encryption
  or master key, and `token` (whose value must be 8 characters or more and not a word). A quoted
  value goes to its closing quote, past any number of escapes. The name and quotes stay; `null`,
  `true`, `false` and structures (`{`, `[`) stay.
- **`Cookie:` and `Set-Cookie:` header values,** to the end of the line.
- **PEM private keys,** through their END line, or to the end of their base64 when cut short.
- **Emails** with an ASCII local part and domain, also with `%40` for the `@`, and glued to another; a
  domain ending like an image (`logo@2x.png`) isn't one.
- **Card numbers:** 13 to 19 digits starting with 2 to 6 that pass the Luhn checksum and aren't one
  digit repeated, written together or in four groups of four separated alike by one space or dash;
  never after a decimal point.
- **After an escape,** each of these is found as if it stood alone: after `\n`, `\r` or `\t` in JSON,
  or a percent-escape (`%20`, `%3D`) in a URL.

Each becomes a marker that says what was there: `[token]` (keys, tokens, Authorization values),
`[secret]` (passwords, named and secret parameters, cookies), `[email]`, `[card]`.

## Does not recognize

Everything else, among it: Go's `\u0026` escapes and text escaped more than once; AWS Signature V4's
header as a whole (its `Signature=` goes as a named secret); `curl -u user:password`; cookies
outside header lines; percent-encoded parameter names; other card groupings and separators (no-break
space, `+`, `%20`, 4-6-5); emails with letters outside ASCII; keys of services not on the list;
Azure's `AccountKey` as such; `password: =` and `password => ...`; a `[` or `]` in a URL's user or
password, which URLs percent-encode; what follows a bare `@` inside a URL's password
(`user:pa@ss@host` leaves `ss`; URLs write it `%40`, which is removed); names, postal addresses,
phone numbers, and passwords in plain prose. Callers check `isSecretName` for named values, which
catches more than patterns.

## Depends on

Nothing.

## Decisions and constraints

- **Doesn't trust the text.** It is whatever logs, errors and prompts hold, and the guarantees below
  hold for any of it. **Trusts its caller,** and the prefixes of its own keys that the caller gives.
- **Guarantees, for any input,** each with a test: time linear in the text's length, whatever the
  text is made of; scrubbing goes on to the end of the text on V8 and on JavaScriptCore, past runs
  of 16 million characters (every repetition is bounded or one character class, and no group
  repeats inside a lookahead or lookbehind, which make V8 throw and JavaScriptCore stop matching on
  long texts); scrubbing the result again changes nothing; it never throws for a string; and what
  isn't a string is returned as `""`, without calling into it.
- **Your own keys by prefix.** A prefix such as `acme_live_` followed by 16 or more key characters
  (letters, digits, `.`, `_`, `~`, `+`, `=`, `-`) is a token, where a key may start (not right after a
  letter, digit, `_` or `-`). Prefixes are matched as written, never as patterns. Make them
  distinctive (`acme_live_`, not `notes.`): `.` and `=` are key characters. At most 100 prefixes of
  1 to 100 characters are taken; other values are ignored. The last set's pattern is kept,
  so passing the same set each time compiles it once.
- **IP addresses stay,** since they are evidence when investigating abuse.
- **Cost:** about 4 ms a megabyte of logs on Bun and on Node (8 to 17 when they hold an `@`, the
  only text searched for emails), under 1.5 µs a 200-character line; the worst text found takes
  under 70 ms a megabyte on Node and under 40 on Bun.
- **Engines:** lookbehind in regular expressions, so every current Chrome, Edge, Node, Bun, Deno and
  Cloudflare Workers, Firefox 78, Safari 16.4.
