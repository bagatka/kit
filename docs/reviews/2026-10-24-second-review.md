# Second review: eight more packages

2026-10-24 · for the founder's decisions

Eight packages joined the toolkit, each first written inside a product and never published. Each
was judged as the first review judged the first ones: as a general concept a stranger installs from
npm, with a contract that says everything a caller needs, strict about what it supports, and safe
on hostile input. Each was redesigned where its contract was shaped by its first caller, not by
its concept.

How it was checked: every file read; the changes tested through each package's contract on both
engines, V8 (Node) and JavaScriptCore (Bun); each built as npm gets it, installed, imported in
Node, and type-checked with the DOM's and with Cloudflare Workers' types; and, where a real system
can answer, against it: another QR encoder and a decoder, Effect's own OpenAPI writer and JSON
encoder, Swift 6.4's compiler. Then two audits, one by Claude auditors and one by Codex, and
mutation testing of every package's tests.

## The packages

| Package | What it is | Gzipped | Tests |
|---|---|---|---|
| `@bagatka/qr-code` | Encodes text as a QR code, versions 1 to 40, and draws SVG path data | 2.7 KB | 8 |
| `@bagatka/quantile-sketch` | Quantiles of any number of values from small sketches that merge | 1.0 KB | 8 |
| `@bagatka/otlp` | Reads and writes OTLP/HTTP protobuf exports of traces and logs | 4.8 KB | 20 |
| `@bagatka/apns` | Sends pushes to Apple devices, every push type | 1.9 KB | 9 |
| `@bagatka/ai-cloudflare-binding` | Effect AI from a Cloudflare Worker through its AI binding: `LanguageModel`, and Clef's decisions | 3.3 KB | 20 |
| `@bagatka/openapi-swift` | Writes a typed Swift 6 client from an OpenAPI 3.1 document | 10.9 KB, build time only | 16, and `check:swift` |
| `@bagatka/app-store-connect` | Follows and publishes an app's releases, any Apple platform | 6.1 KB | 42 |
| `@bagatka/github-app` | A GitHub App: installations, tokens, manifest flow, webhooks | 4.2 KB | 27 |

Sizes are minified and gzipped, with `effect` and the toolkit's own packages left out: an app
pays for Effect once.

## What changed, package by package

### `@bagatka/qr-code`

- **All 40 versions,** up to 2,331 bytes, not 10 and 213: vCards, Wi-Fi configurations and long
  signed links fit. The tables are the standard's (Table 9 and Annex E), and the capacity of every
  version is checked against its Table 7.
- **The standard's mask, the same as another encoder's, module for module.** The standard's rule 3,
  finder-like patterns, is read three ways by the encoders in wide use, each a valid code; this one
  reads it as the standard words it, a 1:1:3:1:1 ratio of any width with a light area 4 widths wide
  on either side, each side counted, the quiet zone included, as Project Nayuki's qrcodegen, written
  independently from the standard, reads it. The two make the same code for 5,325 texts compared,
  all 40 versions and every mask among them, and zxing-cpp, a decoder of its own, read every one
  back. Mutation testing showed the first fixtures never reached five of the eight masks, nor the
  details of the rules that decide one; texts found by searching for each are now captured.
- **Faster and linear:** typed arrays and no allocation per module, 2.7× faster for a link
  (0.3 ms) and 9 ms at version 40; a 10 MB text is refused after one UTF-8 encoding, where the old
  code built an array of ten million numbers first.
- **Tests hold the other encoder's codes,** as SHA-256 digests captured by a program committed
  beside them (`test/fixtures/capture-reference.py`, which `uv run` runs on any machine), never
  written by hand. The tests themselves are TypeScript alone.

### `@bagatka/quantile-sketch`

- **The rank bug is gone:** p55 of 100 values read the 56th, as `0.55 * 100` is
  `55.00000000000001` in floating point; a product that close to a whole number is now taken as
  it, and the test computes the exact rank in whole numbers so it can see the difference.
- **A stored sketch can't throw:** decoding bounds `offset` and `counts` to the buckets a finite
  value can fall in, so merging the widest sketches possible takes milliseconds, where offsets far
  apart threw a `RangeError`.
- **The stored form names its accuracy,** `relativeAccuracy: 0.02`, so changing it later can't
  misread old sketches: a sketch made for another accuracy is refused when decoded.
- **Values in, refusals counted:** `sketchOf` takes plain numbers and returns the sketch and how
  many values were refused (negative, `NaN`, infinite), where `SketchValue.make` threw on the
  ingest path. The largest finite values are held, and read back finite.

### `@bagatka/otlp`

- **Lossless:** every stable field of OTLP 1.x traces and logs is read and written (trace state,
  links, flags, scope attributes, dropped counts, schema URLs), so decoding what it encodes gives
  the same data, checked on .NET's real exports and on data with every field and kind of value.
- **Integers are `bigint`:** an integer past 2^53 and a double such as 3.0 come back as sent.
- **Typed IDs,** `TraceId` and `SpanId`, checked when decoding: an ID of the wrong length is
  refused, where `"zz"` came back `"00"`.
- **Strict, and nothing silent:** text that isn't UTF-8 is refused rather than replaced; span kinds
  and status codes OTLP doesn't define are refused; a negative severity, valid protobuf, is kept
  rather than failing the whole export.
- **Faster:** encoding writes into one growing buffer, 7.8× faster (a 6.7 MB export in 56 ms), and
  decoding is 1.4× faster.
- **Cut:** `countResourceMetrics`, which only counted a metrics export's resources for the product
  that archived them unread. Reading metrics joins when a product reads them.
- **`exportResponse` in OTLP's words,** `{ rejected, errorMessage }`, and a count that isn't a
  whole number from 0 dies, where `-1` wrote a malformed message.

### `@bagatka/apns`

- **Every push type, and its topic:** `pushType` is Apple's `apns-push-type`, and the package
  writes the topic suffix each needs (`.voip`, `.push-type.liveactivity`, `.location-query`, and
  the rest, from Apple's documentation as of October 2026), from the app's bundle ID.
- **A bad key fails the layer,** with `ApnsCredentialsInvalid`, where every push was answered
  `Rejected` with `status: 0`, which a caller forgetting rejected device tokens would have acted
  on for all of them.
- **Inactive is its own answer:** only Apple's 410 says a token is gone, with when;
  `BadDeviceToken` also answers a token sent to the wrong environment.
- **One provider token shared,** signed while concurrent pushes wait, so APNs never sees the token
  renewal storm that triggers `TooManyProviderTokenUpdates`; the key is imported once.
- **Expiration explicit:** a time, `"immediately"`, or Apple's own policy when absent.

### `@bagatka/ai-cloudflare-binding` (was `cloudflare-workers-ai`)

- **Named for what it is, beside Effect's own:** Effect publishes `@effect/ai-cloudflare` (October
  2026), Clef's decisions over Cloudflare's REST API with an account ID and an API token, and no
  language model. This package is Effect AI from inside a Worker, through its AI binding, with no
  token to create, store or leak: Effect's `LanguageModel` on Workers AI, and Effect's own
  `CloudflareDecisionModel` run through the binding by providing its `CloudflareClient`
  (`CloudflareBindingClient`), so Clef's decisions have one implementation, Effect's. The founder
  chose the name; the earlier `workers-ai` said neither Cloudflare nor what it gives. When Effect's
  own packages run through the binding, this one moves to them and retires.
- **The shape of Effect's own providers:** `CloudflareBindingLanguageModel.layer({ binding, model, config })`,
  a `Config` service of Workers AI's request settings by their names, and `withConfigOverride` for
  part of a program, as `OpenAiLanguageModel` has; per-request settings were impossible before.
- **No product's name** in its errors.
- **The binding is checked against Cloudflare's own `Ai` type** by `bun run check`, which now
  type-checks Workers-only bindings as well as globals; a binding whose options don't fit fails it.

### `@bagatka/openapi-swift`

Its input is what Effect's `HttpApi` writes; the review checked what Effect 4.0.5 and 4.0.6 write,
which differs from what the first version assumed: numbers as `"Infinity"`, `"-Infinity"` or
`"NaN"` strings beside JSON numbers, nullable and optional values as `anyOf` with null, encoded
forms named `<Name>Encoded`, Effect's own errors `effect_HttpApiError_<Name>Encoded`, and dates
without `format: date-time`.

- **Compiles in a default Xcode app target:** every type is `nonisolated`, so the file compiles
  when the module's default isolation is the main actor, as new Xcode targets have it, and in a
  library. Checked with Swift 6.4, warnings as errors, in both.
- **Refuses instead of writing Swift that doesn't compile:** arrays in a query, header and cookie
  parameters, a type that holds itself other than in an array or a dictionary, names Swift or
  Foundation take (`Task`, `URLRequest`, …), and every keyword it doesn't know, such as `allOf`
  and `const`, which used to become `JSONValue` silently. Every problem is reported at once, with
  where and why.
- **Constants and nulls survive:** every type has its own `Codable`, so a struct sent on its own
  carries its `_tag`, and a required key that may be null is written as `null`, never left out.
- **No document text writes code:** titles and descriptions become comments with line breaks of
  every kind turned into comment lines, and strings are literals with every control character
  escaped; the client's own helpers are named with raw identifiers no document's name can be, so a
  parameter called `query` or `body` works.
- **Checked as Swift, end to end:** `bun run check:swift` compiles the clients its tests write and
  runs a round trip, the Notes API's client through a fake transport answering with Effect's own
  JSON, checking every request, body, result and error; CI runs it in Swift 6.4 on Linux. Breaking
  the generated code's null or constant handling makes it fail.
- **Paths can't leave the API:** a path is `/` and segments of letters, digits, `-`, `.`, `_`, `~`
  and parameters, none of them `.` or `..`, and the client refuses a parameter's value of `""`, `.`
  or `..`, sending nothing (the audit below found the first).
- **Found by mutation testing, and fixed:** one schema under two names was written as two Swift
  types of one name, which doesn't compile; problems inside a body's or response's schema pointed
  at `application~01json`, escaped twice; problems in a `oneOf`'s members pointed at `anyOf`; four
  of the words Swift reserves (`borrowing`, `consuming`, `nonisolated`, `precedencegroup`) were
  written without backticks, and `_` as a name; and a document without a title hid its other name
  problems.
- **Said out loud:** an optional property that may also be null, Effect's
  `optionalKey(NullOr(...))`, is `nil` when it is missing or null, and left out when `nil`: the
  client can't send its `null`.

### `@bagatka/app-store-connect`

- **Any Apple platform:** versions, builds and review submissions take the platform, `IOS`,
  `MAC_OS`, `TV_OS` or `VISION_OS`, where every write was iOS; the reads return each one's platform.
- **IDs are types of their own:** `AppId`, `BuildId`, `AppStoreVersionId`, `ReviewSubmissionId`.
- **A bad key fails the client,** with `AppStoreConnectCredentialsInvalid`, where every call was
  refused with `status: 0`; one token is shared by calls sent together.

### `@bagatka/github-app` (the general part of `github`)

- **Only the app:** installations, installation tokens, the manifest flow, and webhook signatures.
  The repository questions (tags, commits, comparisons, releases, workflows) were one product's
  release glue, and stay with it, on top of this package's tokens.
- **A bad key or app ID fails the client,** with `GitHubAppCredentialsInvalid`; the app's JWT is
  signed once for everyone; installations are their own type, `InstallationId`.
- **The webhook check accepts a browser's or Deno's `crypto.subtle`,** whose types the structural
  type refused before, as the first review found in the first packages; `bun run check` proves it.

## Security audit of the eight

Independent auditors read the packages with their code but not this review's conclusions, and
proved each finding with a program, on both engines. Everything below was confirmed, fixed, and
given a test that fails without the fix.

| Package | What was found | Now |
|---|---|---|
| `otlp` | A megabyte of empty messages, 2 bytes each, took about 150 MB of heap on V8 and killed a 128 MB isolate (**high**); the encoders wrapped integers past 64 bits and counts and flags past 32, and wrote lone surrogates as U+FFFD, though the contract said data comes back unchanged; a `DataView` body never ended | Each object decoding makes must take 16 bytes of the body (real exports take 30), so a body takes at most about 25 times its size (the attack's shapes are refused in milliseconds, at 13 times); encoding is an Effect that dies, saying which, on what OTLP's fields can't hold; a body that isn't bytes is refused |
| `quantile-sketch` | A stored sketch of more than 2^53 values read quantiles far outside 2%, and merges of valid sketches couldn't be stored; merging is exact on one engine only, as V8 and JavaScriptCore differ in a logarithm's last digit | A stored sketch holds at most 2^53 − 1 values; the README says exact on one engine, and why |
| `qr-code` | `qrCodePath` drew `size²` modules whatever the code held | A code without a QR code's shape draws nothing |
| `apns` | An answer whose body stalled after its headers hung `send` past its 10 seconds; a device token with a lone surrogate made `send` die, and one of `..` posted elsewhere on APNs; a header value the platform refuses read as "unavailable", to be sent again | 10 seconds for the whole answer; `DeviceToken` is hex; a bundle or collapse ID APNs can't take dies, sending nothing |
| `app-store-connect` | An ID of `..` left its path segment: `setWhatToTest` with a build ID of `..` read the team's list of every build's notes and rewrote another build's | Each ID has Apple's shape, an app's digits or a UUID's characters |
| `ai-cloudflare-binding` | A settings object that isn't a literal, such as one parsed from JSON, could replace the prompt or send what the package refuses | Only the eight named settings are sent, and the prompt is written after them |
| `github-app` | `tokenFor(repository)` issued a token for every repository of the installation; a manifest's code, which gives whoever has it the app's private key, appeared in a defect's message and a trace span; a missing webhook signature was a defect, and its hex had two spellings; a slug or organization of `..` led a link elsewhere | Tokens limited to the repository asked for; the code shown as `{code}` and traced nowhere; the signature taken as the request has it, in its one spelling; `AppSlug` and checked logins |

What the auditors checked and found sound includes: no secret in any error, log, or span across
the HTTP packages (38 spans, 5 secrets); tokens sent only to their service's host, the one
followed link included; caches bounded and shared by concurrent calls; constant-time webhook
MACs; the QR tables, error correction, placement and masks against the standard; and otlp's
decoders under 12,000 mutated real exports on both engines, nothing thrown and every round trip
exact.

**`openapi-swift`'s auditor was stopped** by its own safety filter while reading the generator,
and, by the founder's rule, wasn't asked again in other words; Codex's audit, below, then read it.
Before that, in its place: every path from the document's text to the Swift was traced (names checked against strict
patterns or written as raw identifiers that can't hold a backtick, strings through one escaping
literal, text through one comment writer that turns every line break into a comment line), and
200 generated documents of hostile names and text were written and compiled: 61 written, all
compiling with Swift 6.4 in both isolations, the rest refused. That found two bugs, now refused
with their reasons and tested: a string enum's value given twice, and a property named `hashValue`.

## Audit by Codex

Codex (GPT-6.1-sol, at its highest effort) read the eight packages with their code and the audit
above, and proved what it found with programs on both engines. OpenAI's filter stopped it partway;
by the founder's rule it wasn't asked again in other words. Each finding below was confirmed again,
fixed, and given a test that fails without the fix.

| Package | What was found | Now |
|---|---|---|
| `openapi-swift` | A constant property's key, such as a union's `_tag`, reached the Swift unchecked: a document could write code into the client (**high**); a path not starting with `/`, such as `@other.example/x`, sent requests and the bearer token to another host (**high**); properties named `container` or `encoder`, and operations named with a keyword such as `repeat`, wrote Swift that doesn't compile | Every key is checked, and the writer dies on any name that wasn't; paths can't leave the API (above); `self.` before each property and keywords in backticks, both in the fixture the compiler checks |
| `otlp` | A list of empty bytes values took 52 times its size in memory on V8, past the README's 25 (**medium**); every export without a scope or a resource shared one map, so what one request changed reached the next; a span kind or status code OTLP doesn't name was written as `-1`, which decoding refuses | Bytes count against the body's budget, and the densest shapes take at most 21 times; each export has its own; encoding dies, saying which |
| `ai-cloudflare-binding` | A stream that sent `[DONE]` and stayed open hung `streamText` | The answer ends at `[DONE]` |
| `app-store-connect` | IDs read from Apple's answers, such as a localization's, went into request paths unchecked: an answer of `..` sent a `PATCH` elsewhere | Every ID in an answer has the shape of Apple's |

It found the earlier audit's fixes in place, each by a probe of its own: tokens scoped to their
repository, the manifest code in no error or span, the webhook signature's one spelling, the IDs'
shapes, APNs' 10 seconds for the whole answer, the encoders' bounds, the stored sketch's count. Two
limits are now stated rather than changed: data a program makes can be denser than `otlp` decodes,
such as a hundred empty resources in 400 bytes, and encodes to bytes decoding refuses; and
`openapi-swift`'s optional nullable properties (above). A second Codex review, of every change
since, found one regression, a constant named `hashValue` refused like a property, now fixed and
compiled in the fixture, and the rest sound. A third, of the dependency upgrade and the rename to
`ai-cloudflare-binding`, found that decisions through the binding classified Cloudflare's failures
differently from Effect's own REST client (Workers AI's daily quota, timeouts, a deprecated SDK):
failures, text's and decisions' alike, are now the reasons Effect's client gives each code's
documented status, and a test runs every documented failure, and a whole decision's request,
through both clients and compares them. It found nothing else wrong; a type exported from two
places now has one, as nothing was published.

## Mutation testing

Every package's tests were measured by mutation testing (Stryker): a small bug is made in the code,
one at a time, and the tests must catch each one that changes behavior. Every mutant the first run
left was given a verdict: a test that catches it, code cut because nothing observes it, or a reason
it can't matter.

| Package | Mutants | Caught, first run → now |
|---|---|---|
| `qr-code` | 706 | 92.9% → 94.9% of its rewritten penalty rules' 136 |
| `quantile-sketch` | 125 | 88.8% → 94.4% |
| `otlp` | 1,431 | 78.8% → 98.9% |
| `apns` | 169 | 82.2% → 94.7% |
| `ai-cloudflare-binding` | 341 | 68.8% → 94.1% |
| `openapi-swift` | 2,152 | 68.5% → 98.2% |
| `app-store-connect` | 825 | 75.8% → 92.0% |
| `github-app` | 409 | 64.8% → 92.7% |

`qr-code`'s penalty rules were rewritten after its run, so they alone were measured again, with the
rest of the package unchanged; three of their survivors are details no fixture's mask turns on.
What survives is message wording and span names; changes no input tells apart, such as `<=` for
`<` where the two values never meet, or a fallback that finds nothing either way; and branches no
real platform reaches, such as a failure the binding never throws. The tests went from 106 to 150,
many of them tables of cases, and code was cut in five packages: checks another check already
makes, and branches nothing reached. Mutation testing also found the five bugs in `openapi-swift` and the masks
`qr-code`'s fixtures never reached, above.

## Decided for the whole toolkit in this change

- **Service keys:** `"<package>/<file>/<Class>"`, without `/<Class>` when the class's name in
  lowercase is the file's name, as Effect's compiler checks (PATTERNS.md, "Services and layers").
- **Workers-only bindings are platform types too:** `tools/src/platform-types.ts` takes a Cloudflare
  binding's type, checked against Workers' types alone.
- **Swift is checked by its own command,** `bun run check:swift`, run in CI in a Swift 6.4 image
  pinned by digest.
- **No character a reader can't see in code:** `bun run check` refuses one, such as U+2028 or a
  zero-width space, in any TypeScript file; it is written as an escape.
- **Unstable Effect modules allowed by name:** `effect/http` (apns, app-store-connect, github-app),
  `effect/ai` and `@effect/ai-cloudflare` (ai-cloudflare-binding), `effect/http-api`
  (openapi-swift's tests), and `Schema.RetryAfterFromString` (github-app).
- **Packages extend Effect** (AGENTS.md): each is what Effect doesn't have built in, and uses
  Effect's own for the rest. Effect 4.0.6 brought two such: `github-app` reads `retry-after` with
  Effect's `Headers`, either form HTTP allows, where it parsed seconds itself; and unreadable
  answers are Effect's new `InvalidResponseError`, not retried, as in Effect's own providers.
- **Every dependency at its latest version,** runtimes too: Effect 4.0.6 and its packages, the
  linters, the Workers types, and Node 26, the newest release rather than its LTS, in CI and the
  dev shell; Bun follows nixpkgs, which has 1.4.2 while 1.4.4 is out.

## For the founder

1. **Confirm the eight contracts,** especially the ones a product's calls change with:
   `otlp`'s integers as `bigint`, `apns`'s `bundleId` and `pushType`, `app-store-connect`'s platform
   and ID types, `ai-cloudflare-binding`'s `CloudflareBindingLanguageModel.layer` and
   `CloudflareBindingClient.layer`.
2. **Metrics in `otlp`:** reading them joins when a product reads them; a product that archives
   them unread keeps its own framing check.
3. **The rest of `github`:** stays in its product, rebuilt on `@bagatka/github-app`'s tokens.
4. **`openapi-swift`'s optional nullable properties** can't send `null`. The alternative is refusing
   them, so an API that needs the difference says so where it is written.
