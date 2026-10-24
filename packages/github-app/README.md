# @bagatka/github-app

A GitHub App with Effect: its installations and their tokens, its creation from a manifest, and
its webhooks' signatures.

## Install

```sh
npm install @bagatka/github-app effect
```

Its peer dependency is `effect`, at the minor version it is built with. It signs with the
platform's Web Crypto, which the host passes, and sends through the Effect `HttpClient` the host
provides: Cloudflare Workers, Deno, Bun, and Node.

## Use it

```ts
import { GitHubApp, Repository } from "@bagatka/github-app"
import { Effect, Redacted } from "effect"

// In the host, once: fails with GitHubAppCredentialsInvalid if the key or ID can't sign.
const AppLive = GitHubApp.layer(
  { appId: 123456, privateKey: Redacted.make(pemText) }, // the PEM GitHub gave, "BEGIN RSA PRIVATE KEY"
  crypto.subtle,
)

const program = Effect.gen(function* () {
  const app = yield* GitHubApp
  const issued = yield* app.tokenFor(Repository.make("octo-org/notes"))
  // { token: Redacted("ghs_…"), expiresAt }: send it as `Authorization: Bearer` to GitHub's API,
  // for this repository alone.
})
```

An app whose credentials come while the product runs, as from the manifest flow below, is made
with `GitHubApp.make(credentials, crypto.subtle)` instead, once per app, and kept: each client
has its own JWT and token caches.

A repository the app isn't installed on, or an installation GitHub doesn't have, fails with
`GitHubRefused`, which asking again won't change. A rate limit, a 5xx, or no answer in 15 s fails
with `GitHubUnavailable`, with `retryAfter` when GitHub says when to ask again.

Creating the app (GitHub's manifest flow): a page posts `appManifest`'s form to GitHub, the person
confirms the app there, and GitHub sends them to `redirectUrl` with a `code` and the page's
`state`; `convertManifest(code)` then gives the app's ID, slug, private key and secrets, which
GitHub shows only that once, for the host to store. `installLink(slug)` is where someone installs
it. A webhook delivery is checked with `verifyWebhook(crypto.subtle, secret, body, signature)`.

## Contract

`src/index.ts`. Callers build `GitHubApp` with the app's credentials, find its installations, and
get the token to act as one, for a repository or by installation; and create an app from a
manifest and check its webhooks. Each answer is plain data of our own, with GitHub's JSON decoded
and left inside the package.

## Does not own

- **Calling GitHub's API as the app.** An installation's token is what a request to any endpoint
  sends; which endpoints, and what they mean, are the caller's.
- **Where the app's credentials and secrets are kept,** which installation a product's records
  belong to, and the page that posts the manifest's form: the product's.
- **Which person installed the app:** the `installation_id` GitHub adds to the setup URL can be
  forged, so a product checks it with `installations` or `installationOf` before trusting it.

## Depends on

`@bagatka/jwt`, to sign the app's JWTs; `effect`; an `HttpClient` the host provides; and the
platform's Web Crypto, as `crypto.subtle`, which the host passes.

## Settings

The app's ID (or client ID) and private key, from its settings or from `convertManifest`; they
differ per deployment, and per app.

## Decisions and constraints

- **Trusts its caller, the app's key and secrets, and GitHub's API,** reached over TLS. **Doesn't
  trust** a webhook delivery until its signature checks, or the `installation_id` that GitHub adds
  to the setup URL, which anyone can forge.
- **A bad key fails the client, never a request.** A private key that isn't an RSA key of 2048 to
  8192 bits, in PKCS #1 as GitHub gives it or in PKCS #8, or an app ID that isn't a whole number
  or a client ID, fails `make` and `layer` with `GitHubAppCredentialsInvalid`, sending nothing.
- **The app's JWT** is RS256 through Web Crypto, `iat` 60 s in the past and `exp` 9 minutes ahead,
  inside GitHub's 10 even on a clock a minute fast, and signed again after 8 minutes. The key is
  imported once, and requests sent together share one JWT, signed while the others wait.
- **Least privilege:** `tokenFor(repository)` asks GitHub for a token limited to that repository,
  with the installation's permissions; `installationToken`, for one that reaches every repository
  the installation does.
- **Tokens are kept** until 5 minutes before they expire (an hour after issue), one per
  installation and one per repository, and calls at the same time share one request. Which installation reaches a
  repository is kept a minute, so one task's requests ask once, and a reinstalled app, which has a
  new installation, is found within a minute; not being installed isn't kept, so installing takes
  effect at once. A token GitHub revokes before it expires, as when the app is uninstalled, is
  refused (401) until then.
- **Installations are their own type,** `InstallationId`, so an app's ID can't be passed for one.
- **Secrets stay out of errors and logs.** Tokens, the JWT, private keys and client and webhook
  secrets are `Redacted` from the moment they are read; an answer holding secrets that isn't
  shaped as documented dies without saying what differs; Effect's headers redact
  `authorization` when shown.
- **A manifest without a webhook URL has no `hook_attributes`,** since GitHub needs its `url`.
  GitHub's manifest documentation doesn't say what it makes of that; its registration with URL
  parameters has a new app's webhook inactive unless set active. Events reach an app only through
  its webhook.
- **Webhooks are checked as GitHub documents:** HMAC-SHA256 of the delivery's bytes with the
  secret, as `sha256=` and 64 lowercase hex digits, its one spelling, compared byte by byte over the
  whole MAC whatever differs. `verifyWebhook` takes the header as the request has it: a missing one,
  `null`, is `false`, never a defect.
- **A manifest's code stays out of reports:** until it is converted it gives whoever has it the
  app's private key, so messages show its path as `/app-manifests/{code}/conversions`, and its
  request makes no trace span.
- **Names are one path segment:** an app's slug is an `AppSlug`, letters, digits and `-`, and an
  organization's login is checked the same way, so neither can lead a link or a form elsewhere.
- **GitHub's limits are the contract's.** `installations` and `repositoriesOf` read one page of
  100.
- **Rate limits** follow GitHub's documentation: `retry-after` first, then `x-ratelimit-reset` when
  `x-ratelimit-remaining` is 0, else a minute from now.
- **Not handled:** an installation on an enterprise account dies as an answer of another shape
  (`src/answers.ts`).
