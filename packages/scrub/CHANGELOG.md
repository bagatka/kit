# Changelog

## 0.1.2

- A text full of `Bearer`, `Basic` or `Token` credentials that each hold another scheme and end at
  a marker (`"Bearer+A1+".repeat(n) + "[secret]"`, also with `%20`) took time quadratic in its
  length: 80 KB took 0.75 s on Bun and 1.6 s on Node. A declined credential is now read once and
  read past, so the same text takes under a millisecond.
- A named secret's value in single quotes ended at an escaped quote (`password='ab\'cd'` left
  `cd'`), and one inside a JSON string ended at its first escape (`\"password\":\"ab\\ncd\"` left
  `\\ncd`). Both now go to their closing quote, past any number of escapes, as values in double
  quotes did.
- A key with one of the caller's own prefixes no longer starts right after a marker, so scrubbing
  the result again changes nothing for prefixes that don't start with a letter:
  `a@example.com_acme_live_abcdefghijklmnop` with `_acme_live_` scrubbed to
  `[email]_acme_live_abcdefghijklmnop`, and then to `[email][token]`. A prefix with a `[` or `]`
  is ignored, as other unusable prefixes are, since it could start or end inside a marker.

## 0.1.1

`isSecretName` and named values in text know keys in the plural: `api_keys`, `private_keys` and the
other keys. `isSecretName` also knows tokens in the plural, as kinds of token (`access_tokens`,
`refresh_tokens`, `id_tokens`, `auth_tokens`) and as the whole name (`tokens`); named values in text
don't. Counts of tokens (`max_tokens`, `input_tokens`) still aren't secret names.

## 0.1.0

First version: `scrubText` removes what its README's closed list recognizes from text, in time linear
in the text's length, and `isSecretName` tells whether a name holds a secret.
