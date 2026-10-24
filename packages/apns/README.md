# @bagatka/apns

Sends push notifications to Apple devices through APNs with a token-signing key, every push type,
with Effect.

## Install

```sh
npm install @bagatka/apns effect
```

Its peer dependency is `effect`, at the minor version it is built with: your program uses that one
too. It signs with the platform's Web Crypto, which the host passes, and sends through the Effect
`HttpClient` the host provides, which must speak HTTP/2, as `fetch` does in a deployed Cloudflare
Worker.

## Use it

```ts
import { Apns } from "@bagatka/apns"
import { Effect, Redacted } from "effect"

// In the host, once: fails with ApnsCredentialsInvalid if the key or IDs can't sign APNs's tokens.
const ApnsLive = Apns.layer({ key: Redacted.make(p8Text), keyId: "ABCDE12345", teamId: "TEAM123456" }, crypto.subtle)

const program = Effect.gen(function* () {
  const apns = yield* Apns
  const answer = yield* apns.send({
    deviceToken,
    environment: "production",
    bundleId: "com.example.notes",
    pushType: "alert",
    priority: 10,
    payload: { aps: { alert: { title: "Notes · Down", body: "/health has failed for 3 minutes" } } },
  })
  // { _tag: "Accepted", apnsId }; { _tag: "Inactive", reason: "Unregistered", since } for a token
  // the app no longer has: forget it; or { _tag: "Rejected", status: 400, reason: "BadDeviceToken" }.
})
```

When APNs can't be reached, doesn't answer in 10 seconds, or answers 429 or a server error, `send`
fails with `ApnsUnavailable`: the push may be sent again later.

## Contract

`src/index.ts`. Callers build the layer with a key and the platform's Web Crypto, and send one push
at a time, getting APNs's answer: accepted, inactive, or rejected with Apple's reason.

## Does not own

- **What a push says,** its payload, which is the app's.
- **Which device tokens a user has,** and when to forget one: an `Inactive` answer is the signal to
  forget a token, unless the app registered it again after `since`.
- **Sending again** after `ApnsUnavailable`: Apple asks for 15 minutes after a server error.
- **Certificates.** Only token-based authentication, which every push type takes.

## Depends on

`@bagatka/jwt`, to sign its provider tokens; `effect`; the platform's Web Crypto, as
`crypto.subtle`; and an `HttpClient` the host provides.

## Settings

The key's `.p8` text, or its base64 alone, its key ID, and its team ID; they differ per Apple
developer account. The environment is per push, since a device token belongs to one APNs:
development for builds Xcode installs, production for TestFlight and the App Store.

## Decisions and constraints

- **Trusts its caller, its key, and APNs,** reached over TLS; an answer of another shape is still a
  failure, never a guess. **Doesn't trust device tokens,** which come from apps through the caller
  and are checked before any request.
- **Every push type, and its topic.** `pushType` is APNs's `apns-push-type`; the topic is the bundle
  ID with the suffix that type needs (`.voip`, `.push-type.liveactivity`, `.location-query`, and the
  rest), which this package writes, so a push can't name the wrong one. `mdm`, whose topic comes
  from a certificate, isn't supported.
- **A bad key fails the layer,** never a push: a key that isn't P-256 in PKCS #8, or IDs that
  aren't 10 capital letters and digits, fail with `ApnsCredentialsInvalid` when the layer is built,
  so no push is ever answered as rejected for the key, and no caller forgets device tokens over it.
- **Inactive is its own answer.** Only APNs's 410 says a token is gone; `BadDeviceToken` also
  answers a token sent to the wrong environment, and `DeviceTokenNotForTopic` a push with the wrong
  bundle ID, so forgetting tokens on those would forget every token over a setting.
- **One provider token for 50 minutes, signed once.** APNs takes a token for an hour and refuses
  one renewed more often than every 20 minutes. Pushes sent together share one token, signed
  while the others wait; a token APNs calls expired anyway is signed again, once, and the push sent
  once more.
- **What goes into a request is checked first:** a device token is a `DeviceToken`, hex, decoded
  where the product reads it, so it is one path segment; a bundle ID of letters, digits, `-` and
  `.`, and a collapse ID of at most 64 characters of printable ASCII, or the push is a bug and dies,
  sending nothing, never one to send again later.
- **10 seconds for the whole answer,** its body included: an answer that stalls part-way is
  `ApnsUnavailable`.
- **Expiration is explicit:** a time, until which APNs keeps trying; "immediately", to deliver it
  once and never keep it; or absent, for Apple's policy of up to 30 days.
- **An answer that isn't APNs's** (no JSON body, or a reason that isn't one of Apple's camel-case
  words) is `ApnsUnavailable`, never a reason made up or passed into logs.
- **HTTP/2 is the host's.** APNs speaks only HTTP/2, and answers nothing over HTTP/1.1. `fetch` in a
  deployed Worker speaks it; Node's, and workerd's under `wrangler dev`, don't.
