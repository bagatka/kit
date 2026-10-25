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

## Calling a service, and what it shows

The founder asked that every package behave the same for its caller (retries, timeouts, errors)
and be as visible in OpenTelemetry as .NET's own libraries are. What each did differed: whether a
refused token was signed again, how "ask again later" was said, which internal steps were spans,
and how spans were named. PATTERNS.md, "Calling a service, and what it shows", is now the one way;
`apns` and `app-store-connect` follow it, `github-app` in its review.

- **What Effect gives already,** checked in 4.0.6: `Effect.fn` spans, exported with logs and
  metrics by `effect/observability`'s `Otlp`; HTTP client spans with OpenTelemetry's attributes,
  without headers unless asked; trace levels (`Tracer.MinimumTraceLevel`) and log levels
  (`References.MinimumLogLevel`) the host sets. Not: HTTP metrics, which spans give through a
  Collector's span metrics.
- **What a span costs,** measured: about 0.8 µs on Bun and 1.6 µs on Node per `Effect.fn` call even
  with nothing exporting, against 0.1 µs untraced. So spans are for operations, never per item in a
  hot loop.
- **Found:** Effect's HTTP span put APNs's device token, a device's identifier, in `url.full` and
  `url.path` of every push. apns now writes that span itself with `url.template`, and a test that
  fails without it checks that the token appears in no span.

## `@bagatka/github-app`

- **Contract confirmed, brought to "Calling a service".** `GitHubRefused` held 401, 403, 404 and
  422, told apart by `status`. Now `GitHubAppCredentialsRefused` (401, to a JWT signed again too),
  `GitHubForbidden` (403, not a rate limit: a suspended installation, a missing permission), and
  `GitHubRefused` (404 and 422) without `status`; `GitHubUnavailable`'s `retryAfter` is a
  `Duration`, as Effect's `AiError` has it, where it was a time; every error has `isRetryable`.
- **Asks again only with fresh credentials:** a JWT GitHub refuses is signed again once, and a
  token GitHub revoked before it expired is issued again once for the package's own request. RS256
  is deterministic, so signing again in the same second gives the same JWT: it helps a JWT kept
  from earlier.
- **Traced by operation:** the four internal steps that were spans aren't; the manifest's request,
  whose URL holds the code, is a client span of the package's own with `url.template`, where it
  had no span.
- **The README's example compiles** with an `HttpClient` and a retry by `isRetryable`; checked
  against the installed tarball, and against GitHub's API from Node 26 with a made-up app, which
  GitHub refused (401): now `GitHubAppCredentialsRefused`, before `GitHubRefused`.
- **Left as is:** a token the caller sends and GitHub revoked is refused until it expires, as the
  package doesn't see that answer; the README says so.

## `@bagatka/webauthn`

- **The options never fail.** `registrationOptions` and `authenticationOptions` failed with
  Effect's `PlatformError` when the platform had no random bytes, which the README's "every refusal
  is `WebAuthnRejected`" didn't say and no caller can fix: it is a defect now (PATTERNS.md,
  "Errors"), and a test's type fails to compile otherwise.
- **Spans named as the caller writes them,** `verifyRegistration`, not `WebAuthn.verifyRegistration`,
  as `signJwt` is (PATTERNS.md, "Calling a service, and what it shows").
- **The README's example compiles,** with the stores it uses declared, the `Crypto` layer provided,
  and the refusal handled; checked against the installed tarball, and a whole ceremony run from it
  on Node 26: registered, signed in, and a sign-in from another origin refused, with its reason.
- **Registrations are read from the attestation object, decided with the founder.** They were read
  from `response.authenticatorData`, which `toJSON()` gives in Chrome 129, Firefox 119 and Safari
  18.4 and later, but no other client: Android's `registrationResponseJson` and an Apple app's
  `ASAuthorizationPlatformPublicKeyCredentialRegistration` give only the attestation object, the
  CBOR that holds it. Every client gives that, and WebAuthn's steps read it, so one JSON works
  everywhere and no platform needs a special case. Its CBOR is read by a small bounded reader of
  this package's own (definite lengths, 8 levels, lengths within the bytes, each key once, linear
  time); the statement is skipped, as before. The `authenticatorData` and `publicKey` a browser
  sends beside it are ignored, and a test proves that.
- **The W3C's names.** `RegistrationOptions`, `AuthenticationOptions`, `RegistrationResponse` and
  `AuthenticationResponse` are now `PublicKeyCredentialCreationOptionsJSON`,
  `PublicKeyCredentialRequestOptionsJSON`, `RegistrationResponseJSON` and
  `AuthenticationResponseJSON`, as WebAuthn Level 3, the DOM's types, and SimpleWebAuthn name them,
  so a person or an agent who knows WebAuthn knows them. "JSON" names the shape, plain objects with
  bytes as base64url text, not JSON text: each type's doc comment says so. The functions keep their
  names.
- **The options fit the DOM's types.** Their arrays were `readonly` and their values `string`, so a
  typed browser client couldn't pass them to `parseCreationOptionsFromJSON` without a cast. They
  are mutable arrays and literals now (`"public-key"`, `"required"`, `"none"`), and `bun run check`
  type-checks both directions against the DOM's library: the options into its types, its
  `toJSON()` answers into these (`tools/src/platform-types.ts`, `toDom` and `fromDom`).
- **Checked against the specification's own vectors.** WebAuthn Level 3, section 16.7 (ES256 with
  packed attestation) registers and signs in; 16.2's registration is refused, since its person
  wasn't verified. `softwareAuthenticator` now writes an attestation object of format `none`, with
  every field a browser sends.
- **The README** leads with what crosses the wire, a table of what each client (browser, Android,
  Apple's platforms) passes in and posts back, each client's origin, a browser snippet, and a Swift
  one; the TypeScript type-checks against the installed tarball, and the Swift compiles for iOS
  and macOS in Swift 6 with warnings as errors.

## `@bagatka/scrub`

- **Contract confirmed.** Two plain functions that never fail, so no Effect, no span and no error
  type: it runs on every log line, at about 1 µs a line, where a span would double the cost, and
  a span from the code that cleans telemetry would be telemetry about telemetry. PATTERNS.md,
  "Calling a service, and what it shows", is about calling services, which `scrub` never does.
- **The README's examples give what they say,** run from the installed tarball on Node 26, and
  type-check with no platform's types. Its costs were measured again on an M-series Mac: on Node
  4.4 ms a megabyte (15.8 with an `@` on every line) and 1.4 µs a 200-character line; on Bun 2.9,
  7.2 and 0.8.
- **One line of the list was wrong.** A URL's password went "up to the `@` that starts the host",
  but it goes to the first `@`, so `user:pa@ss@host` leaves `ss`. URLs must write that `@` as `%40`,
  which is removed whole; the list now says what happens, under "Does not recognize".
- **npm and GitLab tokens are on the list, decided with the founder:** `npm_` and 36 characters or
  more, and `glpat-` and 20 or more, as CI logs can hold them.

## `@bagatka/qr-code`

- **Contract confirmed.** `encodeQrCode` is pure and synchronous, so it returns a `Result`, not an
  `Effect`, and has no span, as pure functions called per item have none (PATTERNS.md, "Calling a
  service, and what it shows"); its one error, `QrCodeTooLong`, is the caller's to act on, by
  encoding a shorter link.
- **The README's example is a function that returns the SVG.** It built the SVG into a variable it
  never used, and its failure comment gave byte counts its own text couldn't reach. Now
  `qrCodeSvg(text)` returns `Result<string, QrCodeTooLong>`, and it type-checks against the
  installed tarball with unused names refused.
- **The example's SVG scans:** rendered at 600 pixels, zxing-cpp reads back the exact link.
- **Its costs hold,** measured again: a link 0.3 ms, version 40 7 to 8 ms, ten megabytes refused
  in under 1 ms, on Node 26 and Bun 1.4.

## `@bagatka/quantile-sketch`

- **Contract confirmed.** Pure functions of plain data, so no `Effect`, no span and no error type
  of its own: values it can't hold are counted in `refused`, an empty sketch reads as
  `Option.none()`, and a stored sketch is checked by decoding it with `QuantileSketch`. Effect's
  own `Metric.summary` keeps quantiles of a sliding window in memory, which can't be stored or
  merged, so this isn't a second way to do what Effect does.
- **The README's example compiles,** declaring what it reads, and now shows decoding what a store
  gave back, `Schema.decodeUnknownResult(Schema.Array(QuantileSketch))`, which the prose only
  mentioned. Checked against the installed tarball; run on 100,000 made-up durations in ten
  sketches, through JSON: p50, p95 and p99 within 0.2%, 0.9% and 1.7% of the exact values, and a
  sketch of another accuracy refused.
- **Its costs are numbers,** measured: "merging 100 of the widest takes milliseconds" was 21 to
  35 ms.
- **The caller chooses the accuracy, decided with the founder:** 0.5%, 1%, 2% (the default) or
  5%, `RelativeAccuracy`, a closed list so that every sketch has a known largest size, finest
  73,053 buckets. Each sketch names its own, so reading and decoding take no setting.
  `mergeSketches` now returns a `Result`: sketches holding values at different accuracies fail with
  `QuantileSketchesDiffer`, since merging them exactly is impossible and folding into the coarser
  would hide a worse guarantee; empty ones merge with any. Finer than 0.5% isn't offered: clocks
  and minute-to-minute spread are coarser, and data that must be exact is few enough values to
  keep. The README has a table of each accuracy's measured size and cost.
- **Contract change, before the first publish:** the constant `relativeAccuracy` is gone (each
  sketch has its own); `RelativeAccuracy` and `QuantileSketchesDiffer` are new; `sketchOf` takes
  `{ relativeAccuracy }`; `mergeSketches` returns `Result<QuantileSketch, QuantileSketchesDiffer>`.
  No package here calls it.

## `@bagatka/otlp-protobuf`, was `@bagatka/otlp`

- **Contract confirmed.** Effect sends OTLP (`effect/observability`'s `Otlp`) but has no public
  reader of it, so this package is what Effect doesn't have: the receiving side, and writing
  decoded data back. Its one error, `OtlpInvalid`, is the exporter's to fix, and the caller answers
  400.
- **Spans, as every other package has them.** `decodeTraces`, `decodeLogs`, `encodeTraces` and
  `encodeLogs` had none, though each is an operation a caller calls on a request body and takes
  milliseconds; now each is `Effect.fn` with its own name, and a refused body ends its span as a
  failure. Encoding also ran when it was called rather than when its effect ran; it runs inside its
  span now. A test checks the names and outcomes, and fails on the old code.
- **The README's example is a receiver.** It imported `protobufContentType` and never used it,
  and read values it threw away. Now it decodes, keeps what it read, answers 200 with the export
  response, and answers 400 to `OtlpInvalid`, logging its reason. Run from the installed tarball on
  OpenTelemetry .NET's captured export: 19 spans, the first `notes-api`, `GET /api/notes/{id}`,
  32,111,000 ns; the same body cut short, 400 with "The message ends 10 bytes too early, at byte 5".
- **Its costs measured again** on 6.7 MB, 19,000 spans: Bun 59 ms to decode and 48 to encode, Node
  96 and 93.
- **Renamed `@bagatka/otlp-protobuf`, decided with the founder.** Beside Effect's `Otlp`, an
  exporter, `@bagatka/otlp` read as one more way to send telemetry. The name now says what it gives
  and how, as `ai-cloudflare-binding` does: OTLP, in its protobuf encoding, read and written.
  `otlp-codec` was vaguer, and `otlp-receiver` wrong, since it also writes.

## `@bagatka/ai-cloudflare-binding`

- **Contract confirmed, and it fits "Calling a service".** Its failures are Effect's `AiError`,
  whose `isRetryable` and `RateLimitError` say what entry 17's five errors say; it retries nothing;
  a generation has no timeout, as Effect's providers have none.
- **OpenTelemetry's GenAI attributes, which it didn't write.** `effect/ai` makes the span of each
  call and hands it to the provider to describe, as Effect's own providers do; this one left it
  bare and made a span of its own inside it, `CloudflareBindingLanguageModel.generateText`, which
  only repeated it. Now it writes `gen_ai.provider.name` (`cloudflare.workers_ai`, as OpenTelemetry
  names none), `gen_ai.operation.name`, the model and settings, the finish reason and the tokens on
  `effect/ai`'s span, for text and for streams; the repeated span is gone; the binding's run is a
  client span, as an HTTP request is. Prompts and answers are never written. A test checks the
  spans and attributes, and fails on the old code.
- **The README's example compiles** against the installed tarball with Cloudflare Workers' types:
  it used `env` without declaring it, and now declares it as `wrangler types` writes it.


## `@bagatka/openapi-swift`

- **Contract confirmed.** `swiftClient(document)` is one operation, a span of its own name, with
  one error, `UnsupportedOpenApi`, that lists every problem at once; nothing it calls is a service.
- **The README's examples compile, both.** The TypeScript used a top-level `yield*` and an
  undeclared `NotesApi`; it is now a whole build script, an `HttpApi` of one endpoint to
  `Sources/NotesAPI/NotesAPI.swift` through Effect's `FileSystem`. Run from the installed tarball
  on Node with `NodeServices.layer`, it writes a 265-line client. The Swift example used neither
  its result nor its error, which Swift 6 with warnings as errors refuses; it is now a function
  that returns a note's title or what went wrong. Both compile together for iOS 18 with
  `-swift-version 6 -warnings-as-errors`, as a library and with the main actor as the default.
- **The contract's wording:** it takes the document as parsed JSON, such as `OpenApi.fromApi`
  gives, not JSON text.

## `@bagatka/workspace-rules`

- **Contract confirmed.** `checkWorkspace(root, rules)` returns every violation as plain data, and
  fails with `WorkspaceUnreadable` only when the workspace can't be read as a whole.
- **One span, `checkWorkspace`.** Every file and folder it read was a span of its own
  (`readWorkspace.readManifest` and five more); those are steps, `Effect.fnUntraced` now
  (PATTERNS.md, "Calling a service, and what it shows"). Run from the installed tarball on this
  repository with a tracer: one span.
- **It says it is for Bun.** It reads Bun's format, `workspaces.catalog` in `package.json` with
  `workspace:*` and `catalog:`, which npm, Yarn and pnpm don't write; it called itself a checker of
  any "JavaScript workspace". The description, the contract's comment and the README say Bun now,
  and the supported shape names the others as unsupported.
- **The README's example is a CI step.** It used a top-level `yield*` and `Console` without
  importing it; now it prints every violation and fails when there is any. Run from the tarball on a
  made-up Bun workspace, it prints the line its comment shows and exits 1.
