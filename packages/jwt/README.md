# @bagatka/jwt

Signs JSON Web Tokens with ES256 and RS256 keys, such as Apple's `.p8` keys and a GitHub App's,
through the platform's Web Crypto, with Effect.

## Install

```sh
npm install @bagatka/jwt effect
```

Its peer dependency is `effect`, at the minor version it is built with: your program uses that one
too. It runs wherever Web Crypto does: Cloudflare Workers, browsers, Deno, Bun, and Node.

## Use it

```ts
import { importSigningKey, signJwt } from "@bagatka/jwt"
import { Effect, Redacted } from "effect"

const program = Effect.gen(function* () {
  // Once, when the key is read: importing is the slow part.
  const key = yield* importSigningKey(crypto.subtle, "ES256", Redacted.make(p8Text))

  // As often as needed.
  const token = yield* signJwt(
    key,
    { kid: "2X9R4HXF34", typ: "JWT" },
    { iss: issuerId, iat: 1792576800, exp: 1792578000, aud: "appstoreconnect-v1" },
  )
  // "eyJhbGciOiJFUzI1NiIsImtpZCI6IjJYOVI0SFhGMzQiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOi….<86 characters>"
})
```

A key that can't sign with the algorithm asked for (text that isn't base64, two keys in one text,
an RSA key for ES256, a key on another curve, an encrypted key, an RSA key under 2048 bits) fails
with `InvalidSigningKey`, whose `reason`, and `message`, say which, never with the key in it.
Importing it again won't help: report the key. Passing something that isn't `crypto.subtle` is a
bug, and dies.

## Contract

`src/index.ts`. Callers import a key once for an algorithm, then sign headers and claims with it into
compact JWS strings. Signing fails only on a bug, such as claims that aren't JSON (`NaN`, a cycle):
whatever could go wrong with the key, importing it found.

## Does not own

- **What a token says,** and when to sign a new one: each caller chooses its claims and how long a
  token lives.
- **Checking tokens.** This package signs. Verifying another party's tokens, such as Sign in with
  Apple's, needs their published keys and is not built yet.

## Depends on

`effect`, and the platform's Web Crypto, which the caller passes as `crypto.subtle`.

## Decisions and constraints

- **Two algorithms, the ones services ask for.** ES256 (Apple's APNs, App Store Connect, Sign in with
  Apple's client secret) and RS256 (GitHub Apps, Google service accounts). One package for both:
  they share the compact JWS and differ only in the key and the signature.
- **The key decides `alg`.** The header is `{"alg": <the key's algorithm>, ...header}`, and an `alg`
  in `header` is replaced, so a token never claims to be signed differently than it is. `crit` and
  `b64`, which change how a token is read (RFC 7515, RFC 7797), aren't supported: a header with
  either dies.
- **Imported once, and out of reach.** A `SigningKey` is a frozen handle that names its algorithm
  and nothing else; the platform's key behind it stays inside this package, and no file of it hands
  the key out. Web Crypto's "non-extractable" isn't enough on its own: Node's and Bun's
  `KeyObject.from` export such a key, so code holding a `SigningKey` can sign with it, never take
  the key. The functions that look the key up and sign with it are bound when the package loads and
  when the key is imported, so patching `WeakMap` or Web Crypto afterwards can't catch it. Code that
  runs in the same JavaScript realm before that, and patches built-ins, can catch any key, here or
  anywhere: keep code you don't trust out of the realm. Only `importSigningKey` makes a
  `SigningKey`, so signing with one can't fail on the key; and no two are equal in Effect's `Equal`
  and `Hash`, so a cache of tokens by key never hands one key's token out for another.
- **One key, in a form its issuer writes.** A PEM block labelled `PRIVATE KEY` (PKCS #8) for
  either algorithm, or `RSA PRIVATE KEY` (PKCS #1, as GitHub gives it) for RS256; or the base64
  inside a PKCS #8 block alone, on one line, as settings often hold it; line breaks written as `\n`
  are read as line breaks. Refused, each with its reason: two PEM blocks (which would leave which key
  signs to chance), an encrypted key, another label, text that isn't base64, and more than 64 KiB.
  An EC key in SEC1 (`BEGIN EC PRIVATE KEY`) or an encrypted one is converted with `openssl pkcs8
  -topk8 -nocrypt`.
- **Web Crypto checks the key itself.** What the bytes are, the curve, and the key's arithmetic are
  the platform's to check when it imports them; this package doesn't parse them again. Keys made by
  OpenSSL, Apple, GitHub, and Google import the same on every runtime; a malformed key may be
  refused by one runtime and imported by another.
- **RSA keys are 2048 to 8192 bits,** as the platform reports their size: RFC 7518 forbids shorter
  ones for RS256, and a longer one makes every signature slow. Bun reports whole bytes, so there a
  key of 2041 to 2047 bits, which no issuer makes, passes. Multi-prime keys aren't supported.
- **A bad key is the platform's to name.** Web Crypto answers `DataError` for bytes that aren't such
  a key, which is `InvalidSigningKey`; any other failure, such as an object that isn't
  `crypto.subtle`, is a bug of the caller's and dies.
- **ES256's signature is r‖s,** as JWS takes it (RFC 7518, section 3.4), which is what Web Crypto
  makes; nothing converts it, unlike a DER signature from OpenSSL.
- **Claims are JSON, in the order given,** encoded as UTF-8.
- **The platform's object is typed structurally.** `JwtCrypto` names only the two functions this
  package calls, so it compiles without the DOM's or Workers' types; `bun run check` proves that both
  platforms' `crypto.subtle` fit it.
