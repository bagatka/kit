# First review: the first packages

2026-10-23 · for the founder's decisions

Five packages started the toolkit, each first written inside a product and never published. This
review judges each one as a stranger installing it from npm would: is it general enough for the
toolkit, is its name the one people search for, does its contract say everything a caller needs,
and does it hold on hostile input. Four remain; the fifth, `web-crypto`, was removed (see the end).

How it was checked: every file of every package read; claims tested with small programs against the
code (marked **confirmed**), or traced by reading only (marked **plausible**); the packages built as
npm gets them and used from plain Node outside the repository.

## The toolkit test

A package joins the toolkit when it would serve most of the founder's products, and its contract
makes sense to someone who has never heard of them. It is judged as a general concept, never by
how many of today's products call it: they are only its first callers. What keeps the toolkit small
is its surface, not its scope: each package models its general concept and implements only what a
project needs, and grows when another project needs more.

## Verdicts

| Package as first written | Verdict | npm name |
|---|---|---|
| `es256-jwt`, `rs256-jwt` | Merged into one | `@bagatka/jwt` |
| `webauthn` | Contract changed | `@bagatka/webauthn` |
| `web-crypto` | One type fixed; later removed | — |
| `scrub` | Contract changed, made linear | `@bagatka/scrub` |
| `workspace-rules` | As it was, then made strict | `@bagatka/workspace-rules` |

## Found in every package

- **The product's name leaked in,** as a key pattern in `scrub`. Removed.
- **The structural Web Crypto types refused a browser's `crypto.subtle`** (**confirmed**). They took
  `Uint8Array` where the DOM's Web Crypto takes `BufferSource`, which a `Uint8Array` that may sit on
  a shared buffer doesn't fit. Workers' types accept it, so a product on Workers never saw it; any
  browser, Deno, or DOM-typed project would have failed to compile. Fixed (`Uint8Array<ArrayBuffer>`),
  and `bun run check` now type-checks every such type against the DOM's and Workers' own objects
  (PATTERNS.md, "The platform"); reverting the fix makes the check fail.
- **Not publishable as they were:** `exports` pointed at TypeScript source and `effect` was a plain
  dependency. The build here writes JavaScript and declarations, with `effect` as a peer.

## The packages

### `@bagatka/jwt`, from `es256-jwt` and `rs256-jwt`

- **One package.** The two shared the compact JWS and differed only in the key's import and the
  signature; a stranger searches for "jwt", not for an algorithm. The algorithm is a value,
  `JwtAlgorithm`: `"ES256" | "RS256"`.
- **Import once, sign many.** `importSigningKey(crypto.subtle, algorithm, key)` returns a
  `SigningKey`; `signJwt(key, header, claims)` signs. As first written, every call imported the key
  again, which for RSA costs milliseconds, and every caller kept a token cached to avoid it. Signing
  can no longer fail: what could go wrong, importing found.
- **`InvalidSigningKey` says why,** in `reason` (not base64; not a P-256 key in PKCS #8; not an
  unencrypted RSA key), never with the key in it, and names the algorithm.
- **The name leaves room** for verifying tokens (Sign in with Apple's and Google's ID tokens), which
  products will need; not built now.

### `@bagatka/webauthn`

- **The specification's words.** `creationOptions`, `requestOptions`, `verifyAssertion` and
  `AssertionResponse` mixed the browser API's words with the specification's. Now the two
  ceremonies by their names: `registrationOptions` / `verifyRegistration`, `authenticationOptions` /
  `verifyAuthentication`, `AuthenticationResponse`; the same words SimpleWebAuthn and the WebAuthn
  guides use, so people find and read it without a translation.
- **The package makes the challenge.** Callers had to know "32 random bytes or more, base64url, used
  once"; now the options functions make it with Effect's `Crypto` and return it in the options.
  A caller can no longer give a weak or reused one.
- **`origins`, all of them.** `Expected.origin` was one string; a site on `example.com` and
  `www.example.com` couldn't accept both.
- **Smaller fixes:** a credential whose `type` isn't `public-key` is refused; the software
  authenticator returns a user handle of its own instead of a product's, and its `sign` is
  `authenticate`.

### `@bagatka/scrub`

- **No product inside.** A product's ingest-key pattern was built in. Now `scrubText(text,
  ownKeyPrefixes)` takes the caller's own key prefixes (`["acme_live_"]`): every product has keys of
  its own, and a prefix is how keys are made recognizable today.
- **Linear on any input** (**confirmed**). Two patterns could start inside a run of the characters
  they read, so crafted text took quadratic time: 100 KB of `a.a.a.…@aaa…` took 2.8 s, of
  `eyJ-eyJ-…` 1.4 s, on an ingest path. Each pattern now starts only where such a run starts, and
  an address's parts are bounded as the RFC bounds them: the same 100 KB take 0.1 ms. A test feeds
  a megabyte of each worst case.
- **Says what it doesn't remove:** names, addresses, phone numbers, passwords in prose.
- **No dependency at all:** it never used `effect`.

### `@bagatka/web-crypto` and `@bagatka/workspace-rules`

`web-crypto`'s type now accepts a browser's `crypto` too, and a digest copies its input, which Web
Crypto requires to sit on a buffer of its own. `workspace-rules` moved as it was; this repository's
own check is its first caller here.

## Decided for the whole toolkit in this change

- **One entry per package,** `src/index.ts`; test helpers such as `softwareAuthenticator` stay in it,
  documented as such, until a second package needs a `testing` entry.
- **The platform is passed in,** typed structurally, and proven against the DOM's and Workers' own
  types by `bun run check`.
- **What can't work fails when the layer is built** (PATTERNS.md, "Services and layers"): a key
  that can't sign is a failure, never an answer such as a rejection with `status: 0`, which a caller
  that forgets device tokens on rejection would act on.
- **`effect` is a peer at the catalog's minor,** `~4.0.5`, because Effect may change a module it
  marks unstable (`Crypto`, `FileSystem`) in a minor version; a stranger on another minor gets a
  clear install-time conflict instead of a break at run time. Every package is released again when
  the catalog takes a new Effect minor.
- **Each version has a CHANGELOG entry,** and npm gets `src/` with declaration and source maps, so
  "go to definition" lands in the real code.

## For the founder

1. **Confirm the four contracts** above, `jwt`'s merge and `webauthn`'s new words especially.
2. **Going public:** create `github.com/bagatka/kit` (public); the npm organization `bagatka`
   exists. Then the first publish, with a day's token, per `.github/workflows/publish.yml`.

## Security audit of the five

After the review, the founder asked for every vulnerability to be found before anything is
published. Six auditors read the five packages and the release pipeline independently, each proving
its findings with programs: one each for `webauthn`, `jwt`, `scrub`, `web-crypto` with
`workspace-rules`, and the pipeline, and OpenAI's Codex (gpt-6.1-sol) over all of it. Everything
below was confirmed, fixed, and given a test that fails without the fix; the contracts changed where
that was the better design, since nothing is published yet.

| Package | What was found | Now |
|---|---|---|
| `jwt` | A `SigningKey` held the platform's key, which Node's and Bun's `KeyObject.from` export although Web Crypto calls it non-extractable (**high**); RSA keys under 2048 bits accepted, against RFC 7518 (**high**); any import failure blamed on the key; an empty error message; two PEM blocks or trailing bytes read differently by Node and Bun; `b64`/`crit` headers passed through | The key lives in the package's own `WeakMap`, behind a frozen handle; RSA 2048–8192 bits; only `DataError` is a bad key; one PEM block, strict DER, 64 KiB; the reason is in the message; `b64`/`crit` refused |
| `webauthn` | The `userHandle` unchecked, so a caller picking the account by it could be signed in as anyone (**high**); the README's challenge example allowed replay; credential IDs unbounded; the client's `publicKey` trusted instead of the device's key; lenient DER and base64url; backup flags unchecked; attacker text in log reasons | Sign-ins must name the passkey's account; the key is read from the authenticator data; strict, bounded parsing; one encoding per answer; untrusted JSON decoded inside; the README shows taking a challenge once |
| `scrub` | Quadratic patterns (100 KB took 2.8 s); runs of millions of characters threw on Node and silently stopped scrubbing on Bun; secrets missed in escaped and encoded text, connection strings, camelCase names, many key formats; prose destroyed | Every repetition bounded, linear on 60 worst cases up to 16 M characters; far wider coverage, fewer false positives, each gap and false positive stated in the README |
| `web-crypto` | A wrapper returning its own array gave zero bytes; huge sizes exhausted memory; digests unchecked | Reads what `getRandomValues` returns; at most 1 MiB a call; digests checked |
| `workspace-rules` | Duplicate JSON keys read differently by Bun and the check (**high**); `optional`/`peer` dependencies, root dependencies and other catalogs unchecked (**high**); reads outside the root; log injection; stack overflow on long chains | All refused or checked; paths stay inside the root; messages escaped; iterative cycle finding |
| Pipeline | Source maps leaked machine paths; stray files and links in `src/` would be published; one job could both run dependencies and publish; anyone able to push a branch could publish | Maps lead to the shipped `src/`; only TypeScript files of a package's own; the tested tarballs are what is published, by a job that runs nothing of ours, only from `main`'s newest commit, in the `npm` environment |

### Second round

A second, independent audit read the fixed code (Codex's second run was stopped by OpenAI's own
content filter before it reported). It found four more high findings, all now fixed with tests that
fail without the fix: on Bun, a repeated group inside one of scrub's lookaheads made JavaScriptCore
stop scrubbing `Bearer` credentials in large text; a short `authorization=` key read as a scheme;
two `SigningKey`s equal under Effect's `Equal` and `Hash`, so a token cache could mix keys; and a
folder name that isn't UTF-8 hiding a package from the workspace check. Among the rest: RSA size and
exponent now read from the key's own strict DER (Bun rounded 2047 bits up; Node signed with an
exponent of 1); no file of `jwt` hands out the platform's key; a `getRandomValues` that doesn't fill
is a defect, never zeros; user handles must be canonical. Every test now runs on both engines, V8
(Node) and JavaScriptCore (Bun), since the round's worst finding showed only on one.

### Third round

A third audit, of the second round's changes alone, found two more high findings, both in that
round's own fixes, now fixed with tests: scrub's URL-password rule had become too narrow and let
most connection strings through again; and on Linux, a link to a file whose name isn't UTF-8 let
the workspace check read a decoy, which a container run of both engines confirmed and now refuses.
Smaller fixes: `SigningKey`s are equal only to themselves in every copy of Effect; DER is strict
about INTEGERs and identifiers, so Node and Bun accept exactly the same keys; a PKCS #1 key leaves
no copy behind; every random draw is checked; GitHub Actions commands can't start a printed line.
Because scrub regressed twice, every case the three rounds found is now a test: 381 texts with
their expected output, kept and removed alike, each also checked to be stable when scrubbed again,
on both engines. No committed file holds a literal that public secret scanners match.

## Cut to strict support

After the fourth round, which found only edge cases in heuristic code, the founder set the rule now
in `AGENTS.md`, section 9: guarantees hold for every input and are reached by refusing, not by
handling every variant; coverage stops at what the products need; what isn't supported is said, by
a typed error or a violation, or, for a heuristic like scrub, by the README's closed list; and
nothing checks again what the platform checks. Section 10 adds that every test earns its place,
proven by mutation testing (Stryker: a small bug is made in the code, one at a time, and the tests
must catch each one that changes behavior).

| Package | Source lines (start → peak → now) | Tests (peak → now) | Mutants caught | Shipped, gzipped (start → now) |
|---|---|---|---|---|
| jwt | 197 → 568 → 315 | 20 → 9 | 89.9% | 1.1 → 2.0 KB |
| webauthn | 555 → 780 → 761 | 13 → 17 | 82.9% | 2.1 → 2.9 KB |
| web-crypto | 49 → 119 → 69 | 8 → 5 | 72.4% | 0.4 → 0.5 KB |
| scrub | 83 → 447 → 216 | 36 → 8 | 95.1% | 0.8 → 1.9 KB |
| workspace-rules | 422 → 1,140 → 910 | 42 → 26 | 95.6% | 2.6 → 4.9 KB |

Every mutant that survives is accounted for: message wording and span names, which tests don't
pin; equivalent code; paths unreachable on a real platform; and, in webauthn, the test
authenticator's internals. In webauthn, mutation testing found guarantees no test protected — the
credential ID's binding, a one-byte change of the site's hash, the person-present flag, the
credential type, counters past 255 — which now have tests. What was cut: jwt's own DER reader, RSA
exponent check and key zeroing (Web Crypto validates keys); web-crypto's guards against an object
that isn't Web Crypto; strict signature DER in webauthn (verification refuses what it would);
scrub's long tail of formats, now a closed list; and workspace-rules' defenses against a hostile
pull request, replaced by a strict shape: lowercase folder names, no links.

One finding of the second round, left open then, broke a guarantee and is now fixed with a test: a
header that changes as it is read, as a Proxy can, could make `signJwt` write `"alg":"none"` or slip
`crit` past its check. The header is now copied once, and only the copy is read. Of what was cut,
one reason holds only on some runtimes: Web Crypto on Bun refuses an RSA key with an exponent of 1,
and on Node it signs with it, so whoever holds the public key could forge that key's tokens. Only a
key its owner broke has one, and no issuer makes such a key; the README says that a malformed key
may import on one runtime and not another.

## Is each package worth having?

Checked against three questions: does Effect or the platform already do it, does an established
library do it better, and is it a general concept the founder's products will meet (judged as a
concept, never by today's callers)?

- **`web-crypto`: removed.** Effect's own `@effect/platform-browser` has `BrowserCrypto.layer`, the
  same code almost line for line, and it runs on Workers as in browsers (checked on Bun and Node);
  Bun's and Node's platform packages have `BunCrypto` and `NodeCrypto`. A second copy would be kept
  in step with Effect forever.
- **`webauthn`: kept.** Effect has nothing for passkeys. `@simplewebauthn/server`, the established
  library, is 85 KB gzipped with about ten dependencies (ASN.1, X.509, dependency injection), for
  attestation formats the products don't use; this package is 2.9 KB with none but Effect.
- **`jwt`: kept, for signing.** Effect has no JWTs. `jose` is excellent and has no dependencies, but
  is 6.1 KB for the same signing and refuses the PKCS #1 keys GitHub gives GitHub Apps (checked).
  Verifying other parties' tokens, such as Sign in with Apple's and Google's, is where a proven
  library earns its place: keys fetched and cached, algorithms allowed, claims checked.
  Decide when it is needed whether `verifyJwt` joins this package on top of `jose`, so products
  still have one way to handle JWTs.
- **`scrub`: kept.** Nothing in Effect or the platform removes secrets from free text (`Redacted`
  hides values the program knows are secret); any product that stores logs, errors, or feedback
  needs it.
- **`workspace-rules`: kept.** Every monorepo of the founder's runs it; tools such as
  dependency-cruiser, sherif, and syncpack each check a part of it, none these conventions. It is
  the largest (910 lines) but never ships to an app.
