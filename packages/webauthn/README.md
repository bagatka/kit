# @bagatka/webauthn

Passkeys for a site, with Effect: the options a browser or an app registers or signs in with one,
and the checks of what it answers, on the platform's Web Crypto. Stateless: you keep challenges and
passkeys.

## Install

```sh
npm install @bagatka/webauthn effect
```

Its peer dependency is `effect`, at the minor version it is built with. It runs wherever Web Crypto
does: Cloudflare Workers, browsers, Deno, Bun, and Node. Options are made with a new random challenge
from Effect's `Crypto` service, which the host provides: `BrowserCrypto.layer` from
`@effect/platform-browser/BrowserCrypto` on Workers and in browsers, and Effect's platform package
on Bun and Node.

## Use it

Registering, for an account that is signed in:

```ts
import type { Passkey } from "@bagatka/webauthn"
import { challengeOf, registrationOptions, verifyRegistration } from "@bagatka/webauthn"
import { BrowserCrypto } from "@effect/platform-browser"
import { Effect } from "effect"

// What the site keeps: its accounts, challenges for 5 minutes, and passkeys.
declare const account: { readonly id: string; readonly userHandle: string; readonly passkeyIds: Array<string> }
declare const challenges: {
  readonly keep: (challenge: string, bound: { readonly purpose: string; readonly account: string }) => Effect.Effect<void>
  /** Finds and deletes in one step; an empty string when there is none. */
  readonly take: (challenge: string, bound: { readonly purpose: string; readonly account: string }) => Effect.Effect<string>
}
declare const passkeys: { readonly insert: (passkey: Passkey) => Effect.Effect<void> } // refuses an `id` already kept
declare const send: (options: unknown) => Effect.Effect<unknown> // to the browser, and its `credential.toJSON()` back

const register = Effect.gen(function* () {
  const bound = { purpose: "registration", account: account.id }
  const options = yield* registrationOptions({
    rp: { id: "notes.example", name: "Notes" },
    user: { id: account.userHandle, name: "ada@example.com", displayName: "Ada" }, // 1–64 random bytes, canonical base64url
    excludeIds: account.passkeyIds,
  })
  yield* challenges.keep(options.challenge, bound)
  const answer = yield* send(options)

  // Find the kept challenge by the one the answer names, and take it: used once, for this purpose and
  // this account. The answer's own challenge is the client's word, never what you check against.
  const kept = yield* challenges.take(yield* challengeOf(answer), bound)
  const passkey = yield* verifyRegistration(crypto.subtle, answer, {
    challenge: kept,
    origins: ["https://notes.example"],
    rpId: "notes.example",
    userHandle: account.userHandle,
  })
  yield* passkeys.insert(passkey) // { id, publicKey, signCount, userHandle }
}).pipe(
  // Any refusal: log its reason, and tell the person only to try again.
  Effect.tapError((rejected) => Effect.logWarning(rejected.message)),
  // The challenge's random bytes, on Workers and in browsers; NodeCrypto or BunCrypto elsewhere.
  Effect.provide(BrowserCrypto.layer),
)
// register: Effect<void, WebAuthnRejected>
```

Signing in is the same with `authenticationOptions` and `verifyAuthentication`: find the passkey by
the answer's `id` alone, and the account is the passkey's. It checks that the answer names that
account, verifies the signature with the kept public key, and returns the counter to keep.

Every refusal is `WebAuthnRejected`, whose `reason` (and `message`) is for logs: tell the person only
to try again. Untrusted input is refused, never a defect: `verifyRegistration` and
`verifyAuthentication` take the request's JSON as it arrived (`unknown`) and decode it themselves.

## Contract

`src/index.ts`. Callers make options for the two ceremonies, registration and authentication, and
check each answer against the challenge they kept, the origins the site runs on, the site, and, for
a sign-in, the passkey they kept. `softwareAuthenticator` makes and signs passkeys as a device does,
for tests of the sites that check them.

## Does not own

What only the caller can do, which the checks rely on:

- **Each challenge is used once,** for the purpose it was made for and, for a registration, the
  account it was made for: take it (find and delete in one step) when an answer comes. Kept by its
  value alone, a challenge from one account's registration could be answered from another's.
- **Each passkey ID is kept once.** Insert passkeys; never replace one by its ID, and refuse a
  registration whose ID is already kept, for this account or another.
- **A sign-in's account is the passkey's.** Look the passkey up by the answer's `id`, never by the
  `userHandle` the answer names.
- Accounts, sessions, and attestation: which device made a passkey isn't checked, so any
  authenticator may register.

## Depends on

`effect`, for `Crypto` and Schema; and the platform's Web Crypto, which the caller passes as
`crypto.subtle`. A layer of Effect's `Crypto` service, such as `@effect/platform-browser`'s
`BrowserCrypto.layer`, is the host's to install.

## Decisions and constraints

- **Trusts its caller and what the caller keeps:** the challenge, the site, its origins, and the
  stored passkeys. **Doesn't trust anything a browser sends:** registration and sign-in answers
  arrive as untrusted JSON and are decoded here, and every guarantee (nobody signs in as someone
  else, a passkey stays bound to its account) holds against them.
- **The WebAuthn Level 3 specification's words and steps.** Registration (section 7.1) and
  authentication (section 7.2) are checked step by step: the client data's type, challenge, origin,
  `crossOrigin` and `topOrigin`; the site's hash; the person present and verified; the backup flags;
  the credential's ID; the key; the signature over the authenticator data and the client data's
  hash; the counter. Skipped on purpose: attestation (steps 20–24), extensions (none are asked for),
  and keeping backup eligibility (the flags are only checked to agree).
- **The key comes from the authenticator data:** a COSE ES256 key on P-256, in CTAP2's canonical
  form, turned into SPKI here. A `publicKey` the client sends beside it is ignored, so the key kept
  is the one the authenticator data names, and apps that send only `authenticatorData` work as
  browsers do. Without attestation, nothing proves a device wrote that data: any client can write
  it around a key of its own, as `softwareAuthenticator` does. What a passkey proves is that whoever
  registered it holds its key, and that their authenticator saw them present and verified.
- **The account is checked on every sign-in.** The user handle isn't signed, so an answer could name
  any account; it must name the passkey's (step 6), and must name one, as discoverable passkeys do.
- **ES256 only, discoverable, verified, no attestation.** Every passkey manager makes ES256 keys;
  some Windows Hello setups can't, and the browser says so.
- **Challenges are made here:** 32 random bytes from the `Crypto` service the host provides,
  base64url, new for every options. A kept challenge under 16 bytes, such as an empty one from a
  lookup that found nothing, matches no answer.
- **Canonical base64url only** (no padding, line breaks or spare bits). Signatures are DER as
  authenticators write them; whether one is the passkey's is Web Crypto's to say. ECDSA allows a
  second valid signature of the same data, so never use an answer's text as its identity: using each
  challenge once is what keeps an answer from being replayed.
- **Bounded parsing.** Credential IDs are 16 to 1023 bytes, inside the data; a registration's data
  ends with the key unless it says extensions follow; a sign-in's is 37 bytes unless it says so.
  Nothing an answer holds is read beyond its length, and nothing throws.
- **Reasons never echo what an answer chose,** except an origin, quoted, in printable ASCII, and cut
  at 80 characters, so a log line can't be forged or flooded.
- **Several origins.** A site served on more than one origin, such as `https://example.com` and
  `https://www.example.com`, lists them all. An iPhone app's passkeys run on `https://` its associated
  domain.
- **A counter that doesn't move on is refused,** unless it never counts, as synced passkeys don't.
- **The platform's object is typed structurally.** `WebAuthnCrypto` names only the functions this
  package calls; `bun run check` proves that the DOM's and Workers' `crypto.subtle` fit it.
