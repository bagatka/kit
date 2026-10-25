# Publishing review: each package before its first version

2026-10-25 · with the founder

Before the first publish, each package was read once more as a stranger installing it from npm
would: its name, its contract, its README's first example, and the tarball itself, installed in an
empty folder and used from Node. The founder confirmed each contract below; from its first
published version, a change to it is a new version (PATTERNS.md, "Versions").

## `@bagatka/jwt`

- **Contract confirmed:** `importSigningKey(crypto.subtle, algorithm, key)` once per key,
  `signJwt(key, header, claims)` as often as needed, `InvalidSigningKey`, `JwtAlgorithm`,
  `JwtCrypto`, `SigningKey`.
- **The name stays `jwt`,** though it only signs: verifying other parties' tokens joins it when a
  product needs it, so products keep one way to handle JWTs (first review).
- **The README's example compiles:** it declares what it uses, takes the time from `Clock`, and
  shows the failure, `InvalidSigningKey`, in code. Checked by type-checking it against the installed
  tarball, and by verifying tokens it signs, ES256 and RS256, with `jose`.
