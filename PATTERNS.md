# Patterns

One problem, one solution. This file lists the established way to solve each recurring problem in
this repository.

- **Follow an entry.** Before solving a problem listed here, follow its entry and the shape of its
  example.
- **Add a missing entry.** If a recurring problem isn't listed, choose a solution deliberately,
  implement it once, and add an entry in the same change.
- **Change an entry, don't fork it.** If an entry is wrong for a case, propose changing it, with a
  migration path for existing code. Never add a second way "just here."
- **Real code beats snippets.** Each entry names the file that is its specification.

---

## 1. Explicit over implicit

Code says what it does where it does it. A contributor who doesn't know TypeScript's or Effect's
conventions should be able to read any file and see every dependency, conversion, and default.

- **Named exports only.** No `export default`, except where a tool requires one:
  `vitest.config.ts`.
- **Imports name their source.** Effect's modules come from the barrel or a subpath:
  `import { Effect, Schema } from "effect"`, `import { Base64Url } from "effect/encoding"`. Relative
  imports name the file with its extension: `import { isPkcs1 } from "./pkcs8.ts"`.
- **No re-export chains.** A package's `src/index.ts` exports its contract (entry 3); no other file
  re-exports another file.
- **No escape hatches from the type system.** No `any`, no `as` casts (except `as const`), no
  non-null `!`, no `@ts-expect-error`, `@ts-ignore`, or lint-disable comments. `unknown` appears
  only at a trust boundary, and is decoded with a Schema on the next line (entry 7).
- **One step per statement.** A `yield*` is its statement's whole right-hand side: `const x = yield*
  a`, `yield* a`, or `return yield* a`; a pipe on the yielded effect is still one step. Conditions
  only read values computed before them, and are named when they don't read as a sentence.
- **Constants over `let`.** A `let` needs a reason a reader can see, such as a loop accumulator in a
  hot path.
- **No classes of our own,** except the class forms Effect defines: `Context.Service`,
  `Schema.Class`, `Schema.TaggedError`, and `Schema.Opaque`.
- **Never rely on `toString()`** or template interpolation of a value that isn't a string or a
  number.

## 2. Same behavior on every machine

- **Machine-readable text is locale-free:** ISO 8601 for time, JSON numbers for numbers, encoded
  and decoded by Schemas.
- **Human-readable text takes an explicit locale and time zone,** passed by the caller.
- **Files:** UTF-8 without a byte order mark, LF line endings (`.gitattributes`), lowercase
  kebab-case names. No character a reader can't see, such as U+2028 or a zero-width space, sits in
  code as itself: it is written as an escape, `"\u2028"`, and `bun run check` refuses it otherwise.
- **Tests run with `TZ=Pacific/Chatham` and `LANG=tr_TR.UTF-8`** (`bun run test`): a 45-minute
  offset, comma decimals, and a dotless `ı`, so code that depends on the machine fails everywhere.
- **Toolchain:** `./dev` provides the pinned Bun, Node, and npm.

## 3. Packages

Every package has the same shape, so people and agents know where to look before they open it.

```
packages/jwt/
  package.json      name, version, description, keywords, "private": true, "type": "module",
                    "sideEffects": false, "exports": { ".": "./src/index.ts" },
                    "scripts": { "typecheck": "tsc" }, dependencies from the catalog
  tsconfig.json     { "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
  vitest.config.ts
  README.md         the map, from docs/templates/package-readme.md, and the page npm shows
  CHANGELOG.md      "## <version>" for every version, newest first
  src/index.ts      the contract: the only file callers import
  src/*.ts          everything else, private
  test/*.test.ts
```

Canonical example: `packages/jwt`.

- **One entry.** `exports` names only `src/index.ts`; the published `package.json` names the built
  `dist/index.js` and `dist/index.d.ts`. Nothing else is reachable.
- **`src/index.ts` is the contract, and only the contract.** It exports functions, services and
  their layers, Schemas, types, and errors, each from the file that defines it, and holds no logic.
- **Every export has a doc comment:** what it is, what it guarantees, what it costs, and how it
  fails. It is what a caller's editor shows.
- **Names are the domain's.** Where a specification or the npm ecosystem names a concept, the
  package uses that word: WebAuthn's registration and authentication, JWS's compact form, OTLP's
  partial success. The npm name is the thing, not our product: `@bagatka/webauthn`.
- **Dependencies are declared.** `effect` is `"catalog:"`; another package here is
  `"workspace:*"`; what only tests use goes in `devDependencies`. Bun's isolated installs make an
  undeclared import fail, except one of the root's `devDependencies`, which every package can reach
  by walking up `node_modules`: so the root holds tools only, and the workspace rules refuse any
  other root dependency. A package that imports nothing from `effect` doesn't depend on it
  (`packages/scrub`).
- **`"private": true` stays.** It keeps `npm publish` off the source folder; only the build is
  published (entry 13).
- **Size is a signal.** If `src/index.ts` no longer fits on a screen, the package holds more than one
  concept.

## 4. The platform

Packages run on Cloudflare Workers, in browsers, Deno, Bun, and Node, and compile with no platform's
types (`"types": []`), so no package can reach a global that some runtime lacks.

- **What a package needs from the platform, the caller passes,** as the first argument, typed
  structurally as only the functions the package calls, named `<Package>Crypto` or after what it
  is: `importSigningKey(crypto.subtle, ...)` with `JwtCrypto` (`packages/jwt/src/signing-key.ts`).
  Tests pass the runtime's own object, or a fake of that shape.
- **Bytes Web Crypto reads are `Uint8Array<ArrayBuffer>`.** The DOM types Web Crypto's inputs as
  `BufferSource`, which a `Uint8Array` that may sit on a shared buffer doesn't fit: a structural type
  with plain `Uint8Array` parameters accepts Workers' `crypto.subtle` and refuses a browser's. Copy
  bytes of unknown origin with `new Uint8Array(bytes)` before passing them.
- **Every platform type is listed in `tools/src/platform-types.ts`.** `bun run check` builds a
  program that passes the DOM's and Workers' objects to each, so a type that would refuse a runtime's
  object fails here.
- **Data the platform also types fits the platform's type,** such as WebAuthn's JSON: a package's
  values that go to the DOM's API fit its type there (`toDom`), and the DOM's values that come to the
  package fit the package's (`fromDom`), listed in the same file. Arrays that go to the DOM are
  `Schema.mutable`, since its types take mutable arrays (`packages/webauthn/src/webauthn.ts`).
- **Encoding text** uses `TextEncoder` and `TextDecoder`, declared in the file that uses them, in
  the package's terms (`packages/webauthn/src/webauthn.ts`, at its end).
- **Randomness, time, and digests inside Effect code** come from Effect's services: `Crypto`,
  `Clock`, `DateTime`. On Workers and in browsers, `@effect/platform-browser`'s `BrowserCrypto.layer` provides
  `Crypto`; on Bun and Node, their Effect platform packages do.

## 5. Writing Effect code

- **Generators for workflows, pipes for transformations.** A sequence of steps is an `Effect.fn`
  with a name, `Effect.fn("signJwt")`; a transformation of one effect is a `.pipe(...)` on it.
- **No Promises in our code.** No `async`, `await`, `new Promise`, or `.then`. A platform Promise is
  wrapped once, where it enters: `Effect.tryPromise` with a typed error when the caller can act on
  its failure, `Effect.promise` when its failure is a defect.
- **No running inside effects,** and no `try`/`catch` or `throw`. Expected failures are errors in the
  error channel; bugs are defects.
- **Concurrency is stated,** with a bound: `Effect.forEach(items, f, { concurrency: 4 })`.
- **Platform globals are banned** inside Effect code: `Date`, `Math.random`, `crypto.randomUUID`,
  `fetch`, `console`, timers, `process.env`, `JSON.parse` and `JSON.stringify`. `@effect/tsgo`
  reports each one. A package with no Effect in it, such as `scrub`, is plain functions of plain
  data.

## 6. Closed sets

- **A literal union when the cases are labels:** `Schema.Literals(["ES256", "RS256"])`
  (`JwtAlgorithm`).
- **A tagged union when the cases carry different data:** `Schema.TaggedStruct` members, or `Option`
  and `Result`.
- **No TypeScript `enum`.** Switch exhaustively, without a default, so a new case fails the build
  wherever it is ignored.

## 7. Value types and validation

Parse, don't validate. Raw input becomes a typed value once, where it crosses a trust boundary.

- **Contracts take parsed values** where a value has a rule (format, length, range): a branded
  Schema, never a `string` that might be one.
- **Brands make values distinct** where two values would otherwise be confused.
- **`decodeEffect` for typed input, `decodeUnknownEffect` for `unknown`,** inside effects; never
  `decodeSync`.
- **Never silently truncate or "fix" input.** Reject it, and say the rule.

## 8. Services and layers

A package with state or a connection to something outside it is a service: `Context.Service<Self,
Shape>()("<package name>/<file>/<Class>")`, without `/<Class>` when the class's name in lowercase
is the file's name, as the compiler checks, and a `static readonly layer` that takes its settings, such as
`Apns.layer({ key, keyId, teamId }, crypto.subtle)` (`packages/apns/src/apns.ts`).

- **Requirements are `never`** on every method: what a service needs is captured when its layer is
  built.
- **What can't work fails the layer, not every call.** A key that can't be imported, or settings
  out of range, fail when the layer is built, with the package's error, so no caller acts on a
  failure that no call can fix.
- **A package without state is functions,** and a value that is expensive to make is made once by
  a function that returns it: `importSigningKey`, then `signJwt` with what it returned.

## 9. Errors

- **Expected failures are tagged errors,** declared with `Schema.TaggedError` in the file that
  fails with them, exported from the contract, and yielded where they happen: `return yield* new
  InvalidSigningKey({ algorithm, reason })`.
- **Names say what happened:** `<Noun><State>`: `InvalidSigningKey`, `WebAuthnRejected`,
  `WorkspaceUnreadable`.
- **The tag is the stable code.** Callers branch on `_tag`; renaming one is a contract change.
- **`reason` is for logs,** a sentence that says what was wrong, never the secret or the personal
  data that was wrong. A caller shows people its own words. An error with a `reason` overrides
  `message` to include it, so `Cause.pretty` and every logger show it
  (`packages/jwt/src/signing-key.ts`, `InvalidSigningKey`).
- **A contract lists only errors its caller can act on.** A platform failure no caller can fix is a
  defect: `Effect.promise`, or `Effect.orDie` where it happens.
- **Never invent a value for a failure,** such as a status of `0` or an empty ID: a failure is in
  the error channel, or the answer's type says the value can be absent.

## 10. Hostile input

Packages read what strangers send: tokens, keys, bodies, documents, text.

- **Never throw, never hang.** Every way input can be wrong is a typed error or a defined result.
- **Linear time and bounded memory, whatever the input is made of.** A regular expression starts
  only where a run of what it reads starts, never inside one, and bounds every repetition it can
  (`packages/scrub/src/scrub-text.ts`); a parser reads each byte a fixed number of times; nesting has
  a stated limit.
- **A test feeds the worst case** and bounds its time generously, so a slow machine passes and a
  quadratic algorithm doesn't (`packages/scrub/test/scrub-text.test.ts`, "takes time linear").
- **Untrusted input arrives as `unknown`** and the package decodes it with its own Schema, so a
  JavaScript caller's raw JSON is refused with the package's error, never a defect
  (`verifyRegistration`).
- **One encoding of each thing.** Encodings with several texts for the same bytes are read only in
  their canonical form: base64url without padding or spare bits, DER that is strict, so one stored
  answer has one text and can't be re-encoded into another that still verifies
  (`packages/webauthn/src/der-signature.ts`).
- **Every length is checked before it is read,** against the data and against the standard's
  bounds, and nothing may follow a structure unless a flag says so (`verifyRegistration`'s
  credential ID and key).
- **Reasons don't echo what an attacker chose.** A value worth logging, such as an origin, is
  quoted, printable ASCII, and cut short, so it can't forge or flood a log line.
- **Fakes that ship are realistic:** a test authenticator writes what devices write, so tests of a
  caller can't pass on data no device makes.

## 11. Testing

- **Vitest 5 with `@effect/vitest`** (`it.effect`), one `vitest.config.ts` per package; `bun run
  test` runs them all.
- **Through the contract.** Tests import `../src/index.ts`, never private files.
- **Real platform objects** where the runtime has them: tests sign and verify with Node's Web Crypto.
  Fakes only where the real thing can't be steered, such as an authenticator that signs with a
  chosen counter (`softwareAuthenticator`).
- **Fixtures from real systems** are captured once, kept as test files with a note of where they
  came from, and never edited by hand.
- **Names state behavior:** `"refuses a passkey made for another challenge, page or site"`.

## 12. Versions

- **Each package has its own `version`,** from `0.1.0`, and a `CHANGELOG.md` with a `## <version>`
  entry for it; `bun run check` fails without one.
- **A change that reaches npm takes a version.** npm never takes a version twice. Before 1.0.0, a
  change that can break a caller raises the minor (`0.1.0` to `0.2.0`), an addition or a fix the
  patch; from 1.0.0, semver as written. A package's new version raises the packages that depend on
  it too.
- **`effect` is a peer dependency at the catalog's minor,** `~4.0.6`: a program needs one copy of
  it, and Effect may change a module it marks unstable in a minor version. A new Effect minor in the
  catalog is its own change, which runs every check and raises every package that depends on it.
- **1.0.0 is a promise:** a package reaches it when its contract has served two products without
  change.

## 13. Publishing

- **What npm gets is built, never the source folder:** `bun run build` writes each package's
  JavaScript, declarations and their maps, `src/` (so "go to definition" lands in the real source),
  README, CHANGELOG, the repository's LICENSE, and a `package.json` with exact versions
  (`tools/src/build-packages.ts`, `tools/src/published-manifest.ts`).
- **`bun run check` proves each would work for a stranger:** installed side by side, imported in
  Node, type-checked with every declaration under Node's module resolution, with the DOM's types and
  with Workers'.
- **Only a package's own source is built:** every file in `src/` is a TypeScript file of its own,
  never a link or anything else, and the maps lead to the copy of `src/` that ships, never to this
  machine's paths.
- **What is published is the tarball the check installed.** `bun run build` packs each package with
  `npm pack`, refuses a tarball holding anything but `package.json`, `README.md`, `CHANGELOG.md`,
  `LICENSE`, `dist/` and `src/`, and installs the tarballs themselves for the checks.
- **A push to `main` publishes** each `name@version` npm doesn't have, dependencies first, with
  provenance (`.github/workflows/publish.yml`), in two jobs: one installs, checks, tests and packs,
  and can only read the repository; the other installs only npm and runs nothing of ours, publishes those
  tarballs, and alone may ask for the token npm accepts, in the `npm` environment, which only `main`
  deploys to, and only from main's newest commit. npm signs it in by trusted publishing bound to
  that environment; a package's very first version goes with a granular token of that environment,
  made for a day and deleted after; then npm refuses tokens for the package (`mfa=publish`).

## 14. Build and checks

The configuration files are the specification; this entry says what each one owns.

| File | Owns |
|---|---|
| `package.json` (root) | Workspaces, scripts, and the catalog: the one exact version of every dependency |
| `tsconfig.base.json` | Compiler settings and Effect diagnostics every package extends |
| `.oxlintrc.json` | Lint rules, each one turned off with its reason |
| `.oxfmtrc.json` | Formatting |
| `bunfig.toml` | Isolated installs, and exact versions from `bun add` |
| `vitest.config.ts` (root) | Which tests `bun run test` runs |
| `tools/src/workspace-rules.ts` | The dependency rules the check enforces |
| `tools/src/platform-types.ts` | The platform types the check proves each runtime's objects, and the DOM's types, fit |
| `tools/src/published-manifest.ts` | What npm's `package.json` says |
| `.github/workflows/check.yml` | CI: `bun run check` and `bun run test` on every push |
| `.github/workflows/publish.yml` | Publishing to npm, and how npm signs it in |
| `flake.nix`, `flake.lock` | Bun, Node, and npm |

- **Every Effect diagnostic that is on fails the build,** suggestions included. Rules are turned
  off only in their config file, with a one-line reason, scoped to the paths that need it.
- **New dependencies need clear net value.** Add them to the catalog, and call them out in the
  change.
- **Repeated mistakes become checks.** When a mistake repeats, turn on a diagnostic, add a lint rule,
  or extend the repository's check, rather than adding another paragraph here.

## 15. Files and naming

- **One concept per file,** named in lowercase kebab-case after what it exports: `SigningKey` in
  `signing-key.ts`.
- **Names:** values and functions `camelCase`; types, Schemas, services, and errors `PascalCase`; a
  Schema and its type share one name.
- **Package names** are the folder's name under the scope: `packages/jwt` is `@bagatka/jwt`.
- **Tests** sit in `test/`, named after what they cover: `es256.test.ts`.

## 16. Credentials and personal data

- **A credential is `Redacted`** from the moment a package receives it, and never logged, put in an
  error, or kept in a readable form: `importSigningKey` takes `Redacted.Redacted`.
- **A platform key never sits on an object the caller holds.** Web Crypto's "non-extractable" isn't
  enough: Node's and Bun's `KeyObject.from` export such a key. A handle is frozen, names what it is,
  and finds its key in the package's own `WeakMap` (`packages/jwt/src/signing-key.ts`). Key bytes
  are overwritten once imported.
- **Only the platform says a key is bad,** by the error it names for that (`DataError` for Web
  Crypto's `importKey`); any other failure is a bug and dies, so a caller never discards a good key
  because of a wrong argument.
- **Errors never carry the secret or the personal data** that caused them.
- **Fixtures are made up:** keys generated by the test, `ada@example.com`, `notes.example`.

## 17. Calling a service, and what it shows

A package that calls a service (`apns`, `app-store-connect`, `github-app`, `ai-cloudflare-binding`)
behaves the same way as every other one, so a caller learns once how to retry, time out, and debug
all of them. The timings are each service's; the shape is the same
(`packages/apns/src/apns.ts`, `packages/app-store-connect/src/errors.ts`).

- **No package retries a request.** The caller decides, the same way for every package and for
  Effect's own AI errors: `Effect.retry({ while: (error) => error.isRetryable, schedule })`. The one
  exception: a token the service refuses is signed again once and the request sent once more, so
  token rotation never reaches the caller.
- **The errors are these five,** named for the service, each where the service can answer so: `<Service>CredentialsInvalid` (the layer
  can't be built), `<Service>CredentialsRefused` (the service refuses a fresh token),
  `<Service>Forbidden` (the credentials can't do this), `<Service>Refused` (not in this state), and
  `<Service>Unavailable` (ask again later). An answer about one item, such as APNs's `Rejected` for
  one device token, is a value, not an error. A package that provides one of Effect's services, such
  as `LanguageModel`, fails with that service's errors (`AiError`), which say the same.
- **Every error says whether to ask again,** with `isRetryable`, as Effect's `AiError` does: true
  for `<Service>Unavailable` alone. When the service says when, `<Service>Unavailable` has
  `retryAfter`, a `Duration`, as `AiError`'s `RateLimitError` has.
- **Each request has one timeout,** for the whole answer, its body included, stated in the README;
  running out is `<Service>Unavailable`. A model's generation has none, as Effect's providers have
  none: how long it may think is the caller's.
- **A token is signed once and shared** by requests sent together, for a lifetime the README
  states, per client.

What it shows, for OpenTelemetry through Effect's tracer, logger and metrics (`effect/observability`'s
`Otlp` exports all three):

- **One span per operation a caller calls,** named as the caller wrote it: `Apns.send`,
  `AppStoreConnect.prepareVersion`, `signJwt` (`Effect.fn`). Steps inside it are
  `Effect.fnUntraced`: they are the implementation, and a span costs about 1 µs even when nothing
  exports it, which is noise on a request and real time in a hot loop. Pure functions called per
  item, such as `scrubText` or a sketch's insert, have none.
- **Each request is an HTTP client span,** Effect's `HttpClient`'s, with OpenTelemetry's HTTP
  attributes (`http.request.method`, `url.full`, `server.address`, `http.response.status_code`,
  `error.type`); headers aren't recorded, so tokens never are. A URL that holds personal data or a
  secret, such as APNs's device token, gets the package's own client span instead
  (`HttpClient.TracerDisabledWhen`), with the same attributes and `url.template` in place of the
  URL, and a test proves the value appears in no span.
- **A span says the outcome a success hides,** in attributes named for the package (`apns.answer`,
  `apns.reason`). A failure is the span's error, with the error's message, which holds its `reason`.
- **Packages don't log and don't count.** The span tree is the story of a call, with its timings;
  the host logs and derives metrics from it (an OpenTelemetry Collector's span metrics, or its
  backend). A package adds a metric only for what no span shows.
- **The host decides what is kept and what leaves:** `Tracer.MinimumTraceLevel` and sampling, and
  whether `traceparent` goes to the service (`HttpClient.TracerPropagationEnabled`, on by default).

## 18. Recipes

### Add a package

0. Check first: does a package here own this? Does Effect already provide it? Would it serve most
   of the founder's products (`AGENTS.md`, "Repository specifics")?
1. Create `packages/<name>/` with the standard shape (entry 3), version `0.1.0`, its README from the
   template and a CHANGELOG; run `bun install`.
2. Write the contract in `src/index.ts` and a caller example in the README before the
   implementation.
3. Test it through its contract, worst cases included (entry 10).
4. A platform object it takes, or data the DOM also types, goes in `tools/src/platform-types.ts`.
5. Add it to the parts table in `ARCHITECTURE.md`.
6. `bun run check` and `bun run test` pass. Review its contract with the founder before it is
   published.

### Move a package from a product

1. Copy its tracked files, without their history: commits here never name the product or its
   repository, as this repository is public.
2. Rename it to `@bagatka/<name>`, take out every product name and product-specific rule, redesign
   what its first caller shaped rather than its concept, and apply the review's decisions
   (`docs/reviews/`).
3. As in "Add a package", from step 3.
4. The product switches to the npm version only once it is published, deleting its copy in the same
   change.

### Release a version

1. Raise `version` in the package's `package.json`, and in every package here that depends on it.
2. Add `## <version>` to each one's CHANGELOG, saying what changed for a caller.
3. `bun run check`, then push to `main`; the workflow publishes what npm doesn't have.
