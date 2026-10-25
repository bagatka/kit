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

## `@bagatka/app-store-connect`

- **Contract confirmed, with its errors split by who acts.** `AppStoreConnectRefused` held Apple's
  401, 403 and 409 alike, told apart only by `status`: a revoked key read like a build still
  processing, though one stops every release until someone fixes it and the other only this one.
  Now:
  - `AppStoreConnectCredentialsRefused`: 401, a token signed again too; fix the credentials.
  - `AppStoreConnectForbidden`: 403, the key's role can't do this, or the team owes an agreement
    (`FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`, which forbids every request). Its own
    error, not the 401's: a Developer key's reads still work while its writes are forbidden.
  - `AppStoreConnectRefused`: 409 alone, a change Apple won't take now; its `status` is gone.
  - `AppStoreConnectUnavailable` is unchanged, as in `apns`.
- **The README's examples compile,** with what a stranger must add (an `HttpClient`, the ID types'
  imports), and a table of which error asks whom to act. Checked by type-checking both against the
  installed tarball, and against Apple's API from Node 26 with a made-up key, which Apple answered
  `NOT_AUTHORIZED` twice: now `AppStoreConnectCredentialsRefused`.
- **Read, and left as they are:** the writes read first and change only what differs, so calling
  one again after an outage repeats nothing; IDs in paths, and in Apple's answers, have Apple's
  shape; the token goes only to Apple's API. Reads return Apple's states and platforms as strings,
  as Apple names them, as decided in the second review.
