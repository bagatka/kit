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

## `@bagatka/apns`

- **Contract confirmed, with one change:** `Apns.layer(credentials, crypto.subtle)`, `send(push)`
  answering `Accepted`, `Inactive` or `Rejected`, failing with `ApnsUnavailable`, and now also with
  `ApnsCredentialsRefused`.
- **Credentials APNs refuses are an error, not an answer.** A key that imports but that APNs
  refuses, 403 `InvalidProviderToken` (revoked, or the wrong key or team ID), was answered
  `Rejected` on every push: a caller that logs and drops rejected pushes would never see the outage,
  and one that forgets device tokens on rejection would act on a setting. It is now
  `ApnsCredentialsRefused`, so the type shows it, as `ApnsCredentialsInvalid` shows a key that can't
  be read when the layer is built. Other 403s, such as `Forbidden`, stay answers about the push. A
  token APNs calls expired twice in a row, the second just signed, stays `Rejected`, as before.
- **The README's example compiles** and shows what a stranger must add: an `HttpClient`
  (`FetchHttpClient.layer`), a device token decoded with `DeviceToken`, and each answer handled.
  Checked by type-checking it against the installed tarball, and by sending to APNs's sandbox from
  Node 26 with a made-up key, which APNs answered `InvalidProviderToken`: now
  `ApnsCredentialsRefused`.
