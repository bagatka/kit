# @bagatka/app-store-connect

Follows and publishes an app's releases through the App Store Connect API, on any Apple platform,
with Effect: an app by its bundle ID, its builds and their TestFlight states, and its App Store
versions with the build each ships and its phased release; and, for iOS, macOS, tvOS or visionOS,
prepares a version with its build and What's New, submits it for review, releases it, steers its
phased release, and writes a build's What to Test.

## Install

```sh
npm install @bagatka/app-store-connect effect
```

Its peer dependency is `effect`, at the minor version it is built with. It signs with the
platform's Web Crypto, which the host passes, and sends through the Effect `HttpClient` the host
provides: Cloudflare Workers, Deno, Bun, and Node.

## Use it

```ts
import { AppStoreConnect } from "@bagatka/app-store-connect"
import { Effect, Option, Redacted } from "effect"

// In the host, once: fails with AppStoreConnectCredentialsInvalid if the key or IDs can't sign.
const AppStoreConnectLive = AppStoreConnect.layer(
  { key: Redacted.make(p8Text), keyId: "2X9R4HXF34", issuerId: "57246542-96fe-1a63-e053-0824d011072a" },
  crypto.subtle,
)

const program = Effect.gen(function* () {
  const appStoreConnect = yield* AppStoreConnect
  const app = yield* appStoreConnect.app("com.example.notes")
  if (Option.isNone(app)) {
    return [] // the key's team has no such app
  }
  const builds = yield* appStoreConnect.builds(app.value.id, 20)
  // [{ platform: "IOS", version: "2.4.0", buildNumber: "413", processingState: "VALID", … }]
  const versions = yield* appStoreConnect.appStoreVersions(app.value.id, 5)
  // [{ platform: "IOS", version: "2.4.0", state: "READY_FOR_DISTRIBUTION", buildNumber: "413",
  //    phasedRelease: { state: "ACTIVE", currentDay: 3 }, … }]
  return versions
})
```

Publishing a version, with a key whose role is App Manager:

```ts
const publish = (appId: AppId, buildId: BuildId) =>
  Effect.gen(function* () {
    const appStoreConnect = yield* AppStoreConnect
    const locales = yield* appStoreConnect.appLocales(appId) // ["en-US", "de-DE"]
    const prepared = yield* appStoreConnect.prepareVersion(appId, {
      platform: "IOS",
      version: "2.5.0",
      buildId,
      releaseType: "manual",
      phased: true,
      whatsNew: locales.map((locale) => ({ locale, text: notesIn(locale) })),
    })
    // { versionId: "f5b10fc0-…", version: "2.5.0", state: "PREPARE_FOR_SUBMISSION" }
    return yield* appStoreConnect.submitForReview(appId, "IOS", prepared.versionId)
    // { submissionId: "…", state: "WAITING_FOR_REVIEW" }; once approved, releaseVersion(prepared.versionId)
  })
```

A key that is wrong or revoked, or whose role can't do this, fails with `AppStoreConnectRefused`
(401 or 403), as does a change Apple won't take now (409), with Apple's code and detail: a build
still processing, a text over 4,000 characters, a version not pending release. Asking the same again
won't help until what it names changes. No answer in 15 seconds, too many requests (429), or a server
error fail with `AppStoreConnectUnavailable`: ask again later. Every method is safe to call again.

## Contract

`src/index.ts`. Callers build a client with an API key and the platform's Web Crypto (`make`, or
`layer` for one key known when the host starts), read an app's builds and App Store versions as plain
values with Apple's states as Apple names them, and move a version for a platform from prepared to
released. Each ID is a type of its own (`AppId`, `BuildId`, `AppStoreVersionId`,
`ReviewSubmissionId`), so one can't be passed where another is asked for, and each has Apple's
shape, an app's digits or a UUID's letters, digits and `-`, so it is one segment of a path: never
`.` or `..`, which would reach another resource.

## Does not own

What a state means for a release, how often to ask, and when to wait for a build or a review: the
caller decides. The rest of a version's metadata (description, screenshots, App Review information):
App Store Connect.

## Depends on

`@bagatka/jwt`, to sign its tokens; `effect`; the platform's Web Crypto, as `crypto.subtle`; and an
`HttpClient` the host provides.

## Settings

The API key's `.p8` text (or the base64 inside it), its key ID, and its team's issuer ID, from App
Store Connect's Users and Access, Integrations. They differ per team. A team key has its role on
every app; an individual key, its user's.

- **Reading** (`app`, `builds`, `build`, `appStoreVersions`, `appLocales`) works with a key whose
  role is **Developer**, the least that views an app's builds in App Store Connect ([View builds and
  metadata](https://developer.apple.com/help/app-store-connect/manage-builds/view-builds-and-metadata)).
- **Writing** (`prepareVersion`, `submitForReview`, `releaseVersion`, `setPhasedRelease`,
  `setWhatToTest`) needs **App Manager**, or Admin or Account Holder. Apple's [role
  permissions](https://developer.apple.com/support/roles/) give "Submit apps" and "Manage TestFlight
  builds" to these alone, and its help asks the same for choosing a build, releasing a version, a
  phased release, and test information. Marketing may make versions and edit their details, but not
  submit them, so it isn't enough.

A product that reads often and writes rarely can hold two clients, one per key, each with `make`.

## Decisions and constraints

- **A bad key fails the client, never a request.** A key that isn't P-256 in PKCS #8, a key ID
  that isn't 10 capital letters and digits, or an issuer ID that isn't a UUID fails `make` and
  `layer` with `AppStoreConnectCredentialsInvalid`, sending nothing.
- **One token for 15 minutes, signed once.** The key is imported once. Apple takes a token for at
  most 20 minutes, so each is signed for 20 and kept for 15, and none is sent about to expire;
  requests sent together share one, signed while the others wait. A token Apple refuses (401) is
  signed again, once, and the request sent once more; a second refusal is `AppStoreConnectRefused`.
  Each client from `make` has its own token.
- **Related resources come in the same answer.** Builds are read with `include` of their prerelease
  version (the marketing version) and beta detail (TestFlight states), versions with their build and
  phased release, and app infos with their localizations and the app's primary locale, so a list is
  one request, not one per item.
- **Builds are sorted by Apple, versions here.** Builds are asked for with `sort=-uploadedDate`.
  Apple documents no sort for an app's App Store versions, so every page of them is read (200 a
  page, at most 10 pages) and sorted by when each was made.
- **Writes read first, and change only what differs.** Each write method reads what Apple has, then
  makes, changes, or removes only what differs from what was asked, in an order Apple takes: a
  version's string before its build, its build before it is submitted. So calling one again, after
  a refusal or an outage part-way, finishes what was left and repeats nothing; a version already
  submitted, released, or paused is left as it is.
- **Each platform's versions on their own.** A version, its review submission, and a build are each
  for one platform, `IOS` (iPhone and iPad), `MAC_OS`, `TV_OS`, or `VISION_OS`, as Apple names
  them; the writes take the platform, and the reads return it, as Apple says it, so a platform Apple
  adds later is read as it is.
- **An app's first version has no What's New and no phased release.** Apple's help says What's New
  "isn't available for the first version of the app", and its API, that phased releases are "not
  available for the first version". A version is the first when the app has no other version for
  its platform; `prepareVersion` then writes neither, and the version goes to everyone once
  released.
- **A version's locales are the app information's.** Apple takes a version for review only when its
  localizations match its app info's, so `appLocales` reads those of the app info for the version
  being prepared (or the live one), and `prepareVersion` adds a locale the version lacks with What's
  New alone, leaving its description to App Store Connect.
- **Submissions go through `reviewSubmissions`.** A version is added to the platform's open draft
  submission, or a new one, and the submission submitted; a submission that already holds it is reused, and one
  App Review rejected is resubmitted after its item is marked resolved.
- **Answers decode through Schemas.** What the client needs is required, and anything else Apple
  sends is ignored. An answer without what it needs, a related resource named but not included, a
  page link outside the API, or an HTTP status other than 200, 201, 204, 401, 403, 409, 429 and 5xx
  is a defect, with a message that says what was off. Apple's 400 and 422 are requests in a shape it
  doesn't take: this client's bug.
- **Apple's filters aren't documented as exact.** Only an app whose bundle ID equals the one asked
  for is returned, and only a build with exactly the version and build number asked for.
- **Apple limits each key's requests per rolling hour** (3,500 in its documentation's example; its
  `X-Rate-Limit` header says how many remain), and answers 429 past it. `prepareVersion` takes two
  requests, and one more per change and per locale written: about 45 for an app in 40 locales, each
  a subrequest of the Worker's.
