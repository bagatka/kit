import { assert, describe, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Fiber, Layer, Redacted, Result, Schema, Struct } from "effect"
import { Base64, Base64Url } from "effect/encoding"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"

import type { ApnsCredentialsRefused, ApnsCrypto, ApnsPush, ApnsUnavailable } from "../src/index.ts"
import { Apns, ApnsAnswer, DeviceToken } from "../src/index.ts"

// The runtime's Web Crypto, text decoder and `Response`, which tests outside a runtime with their
// types can't name: the parts these tests use.
declare const crypto: {
  readonly subtle: ApnsCrypto & {
    generateKey(
      algorithm:
        | { readonly name: "ECDSA"; readonly namedCurve: "P-256" | "P-384" }
        | {
            readonly name: "RSASSA-PKCS1-v1_5"
            readonly modulusLength: 2048
            readonly publicExponent: Uint8Array
            readonly hash: "SHA-256"
          },
      extractable: true,
      keyUsages: Array<"sign" | "verify">,
    ): Promise<{ readonly privateKey: unknown; readonly publicKey: unknown }>
    exportKey(format: "pkcs8", key: unknown): Promise<ArrayBuffer>
    verify(
      algorithm: { readonly name: "ECDSA"; readonly hash: "SHA-256" },
      key: unknown,
      signature: Uint8Array,
      data: Uint8Array,
    ): Promise<boolean>
  }
}
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }
declare const Response: new (
  body: string | null | object,
  init: { readonly status: number; readonly headers?: Readonly<Record<string, string>> },
) => object
declare const ReadableStream: new (source: {
  readonly start: (controller: { readonly enqueue: (chunk: Uint8Array) => void }) => void
}) => object
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array }

// A key of the tests' own, as Apple's `.p8` file holds one.
const newKey = (algorithm: Parameters<typeof crypto.subtle.generateKey>[0] = { name: "ECDSA", namedCurve: "P-256" }) =>
  Effect.gen(function* () {
    const pair = yield* Effect.promise(() => crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]))
    const der = new Uint8Array(yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)))
    const pem = `-----BEGIN PRIVATE KEY-----\n${Base64.encode(der)}\n-----END PRIVATE KEY-----\n`
    return { pem, publicKey: pair.publicKey }
  })

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const bytesOf = (base64Url: string | undefined) =>
  Result.getOrElse(Base64Url.decode(base64Url ?? ""), () => new Uint8Array(0))

interface Asked {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

type FakeAnswer = { readonly status: number; readonly body?: string } | "no answer" | "never" | "stalls"

// A fake APNs: answers each push with the next of `answers`, then 200, and keeps what it was asked.
const fakeApns = (answers: Array<FakeAnswer>) => {
  const asked: Array<Asked> = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = request.body._tag === "Uint8Array" ? textOf(request.body.body) : ""
      asked.push({ url: url.href, headers: request.headers, body })
      const answer = answers.shift() ?? { status: 200 }
      if (answer === "never") {
        return yield* Effect.never
      }
      if (answer === "stalls") {
        // An answer's headers, then a body that starts and never ends.
        const unending = new ReadableStream({
          start: (controller) => controller.enqueue(new TextEncoder().encode('{"reason":')),
        })
        return HttpClientResponse.fromWeb(request, new Response(unending, { status: 400 }))
      }
      if (answer === "no answer") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "No route" }),
        })
      }
      return HttpClientResponse.fromWeb(
        request,
        new Response(answer.body ?? null, {
          status: answer.status,
          headers: { "apns-id": "4f0e5d2c-8b1a-4c3e-9d7f-1a2b3c4d5e6f" },
        }),
      )
    }),
  )
  return { asked, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

const push: ApnsPush = {
  deviceToken: DeviceToken.make("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90"),
  environment: "development",
  bundleId: "com.example.notes",
  pushType: "alert",
  priority: 10,
  payload: { aps: { alert: { title: "Notes · Down", body: "https://notes.example/health is down" } } },
  collapseId: "incident-1",
}

const credentialsOf = (pem: string) => ({ key: Redacted.make(pem), keyId: "ABCDE12345", teamId: "TEAM123456" })

// Runs `program` with APNs on `pem`, through `apns`.
const withApns = <A, E>(pem: string, apns: ReturnType<typeof fakeApns>, program: Effect.Effect<A, E, Apns>) =>
  program.pipe(Effect.provide(Apns.layer(credentialsOf(pem), crypto.subtle).pipe(Layer.provide(apns.layer))))

const send = (one: ApnsPush = push) =>
  Effect.gen(function* () {
    const apns = yield* Apns
    return yield* apns.send(one)
  })

const tokenOf = (asked: Asked | undefined) => (asked?.headers["authorization"] ?? "").replace("bearer ", "")

// When the tests' clock is set: 2026-10-24T09:30:00Z, 1792834200 seconds since the epoch.
const someMorning = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-24T09:30:00Z"))

describe("Apns", () => {
  it.effect("sends a push to its environment's APNs, with a provider token its key signed", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([])
      yield* TestClock.setTime(someMorning)
      const answer = yield* withApns(key.pem, apns, send())

      assert.deepStrictEqual(answer, { _tag: "Accepted", apnsId: "4f0e5d2c-8b1a-4c3e-9d7f-1a2b3c4d5e6f" })
      const asked = apns.asked[0]
      assert.strictEqual(asked?.url, `https://api.sandbox.push.apple.com/3/device/${push.deviceToken}`)
      assert.deepInclude(asked?.headers, {
        "apns-topic": "com.example.notes",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-collapse-id": "incident-1",
      })
      assert.notProperty(asked?.headers, "apns-expiration")
      assert.strictEqual(
        asked?.body,
        '{"aps":{"alert":{"title":"Notes · Down","body":"https://notes.example/health is down"}}}',
      )

      // An ES256 JWT: its header names the key, its claims the team and when it was signed, in
      // seconds, and its signature verifies.
      const [header, claims, signature] = tokenOf(asked).split(".")
      assert.strictEqual(textOf(bytesOf(header)), '{"alg":"ES256","kid":"ABCDE12345"}')
      assert.strictEqual(textOf(bytesOf(claims)), '{"iss":"TEAM123456","iat":1792834200}')
      const verified = yield* Effect.promise(() =>
        crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key.publicKey,
          bytesOf(signature),
          Uint8Array.from(`${header}.${claims}`, (character) => character.charCodeAt(0)),
        ),
      )
      assert.isTrue(verified)
    }),
  )

  it.effect("writes each push type's topic, priority and expiration as APNs requires them", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([])
      const pushes: ReadonlyArray<ApnsPush> = [
        { ...push, environment: "production", pushType: "liveactivity", priority: 5, expiresAt: "immediately" },
        { ...push, pushType: "voip", expiresAt: DateTime.makeUnsafe("2026-10-24T09:30:00Z") },
        { ...Struct.omit(push, ["collapseId"]), pushType: "background", priority: 5 },
        { ...push, pushType: "location", priority: 1 },
        { ...push, pushType: "pushtotalk" },
        { ...push, pushType: "widgets", priority: 5 },
        { ...push, pushType: "controls", priority: 5 },
        { ...push, pushType: "complication" },
        { ...push, pushType: "fileprovider", priority: 5 },
        { ...push, pushType: "accessory" },
      ]
      yield* withApns(key.pem, apns, Effect.forEach(pushes, send))
      assert.deepStrictEqual(
        apns.asked.map((asked) => [
          asked.url.slice(0, asked.url.indexOf("/3/")),
          asked.headers["apns-topic"],
          asked.headers["apns-push-type"],
          asked.headers["apns-priority"],
          asked.headers["apns-expiration"],
        ]),
        // Each type's topic as Apple's "Sending notification requests to APNs" gives it.
        [
          ["https://api.push.apple.com", "com.example.notes.push-type.liveactivity", "liveactivity", "5", "0"],
          ["https://api.sandbox.push.apple.com", "com.example.notes.voip", "voip", "10", "1792834200"],
          ["https://api.sandbox.push.apple.com", "com.example.notes", "background", "5", undefined],
          ["https://api.sandbox.push.apple.com", "com.example.notes.location-query", "location", "1", undefined],
          ["https://api.sandbox.push.apple.com", "com.example.notes.voip-ptt", "pushtotalk", "10", undefined],
          ["https://api.sandbox.push.apple.com", "com.example.notes.push-type.widgets", "widgets", "5", undefined],
          ["https://api.sandbox.push.apple.com", "com.example.notes.push-type.controls", "controls", "5", undefined],
          // Apple's page prints this suffix as `h.complication`, a stray letter before `.complication`.
          ["https://api.sandbox.push.apple.com", "com.example.notes.complication", "complication", "10", undefined],
          [
            "https://api.sandbox.push.apple.com",
            "com.example.notes.pushkit.fileprovider",
            "fileprovider",
            "5",
            undefined,
          ],
          ["https://api.sandbox.push.apple.com", "com.example.notes.push-type.accessory", "accessory", "10", undefined],
        ],
      )
      // A push without a collapse ID has no header for one.
      assert.notProperty(apns.asked[2]?.headers, "apns-collapse-id")
    }),
  )

  it.effect("signs one provider token for 50 minutes, shared by pushes sent together", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([])
      yield* TestClock.setTime(someMorning)
      yield* withApns(
        key.pem,
        apns,
        Effect.gen(function* () {
          yield* Effect.all(
            Array.from({ length: 8 }, () => send()),
            { concurrency: "unbounded" },
          )
          yield* TestClock.adjust("49 minutes")
          yield* send()
          // 50 minutes after it was signed, the token is signed again.
          yield* TestClock.adjust("1 minute")
          yield* send()
        }),
      )
      const tokens = apns.asked.map(tokenOf)
      assert.strictEqual(new Set(tokens.slice(0, 9)).size, 1)
      assert.notStrictEqual(tokens[9], tokens[0])
    }),
  )

  it.effect("signs another token when APNs calls one expired, and sends the push once more", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([{ status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { status: 200 }])
      const answer = yield* withApns(key.pem, apns, send())
      assert.strictEqual(answer._tag, "Accepted")
      assert.strictEqual(apns.asked.length, 2)
      assert.notStrictEqual(tokenOf(apns.asked[1]), tokenOf(apns.asked[0]))
    }),
  )

  it.effect("tells an inactive device token, with when, from a refused push", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([
        { status: 410, body: '{"reason":"Unregistered","timestamp":1792834200000}' },
        { status: 400, body: '{"reason":"BadDeviceToken"}' },
        { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
        { status: 403, body: '{"reason":"ExpiredProviderToken"}' },
      ])
      const answers = yield* withApns(key.pem, apns, Effect.all([send(), send(), send()]))
      assert.deepStrictEqual(answers, [
        { _tag: "Inactive", reason: "Unregistered", since: DateTime.makeUnsafe("2026-10-24T09:30:00Z") },
        { _tag: "Rejected", status: 400, reason: "BadDeviceToken" },
        // Expired twice, the second time with a token just signed: not sent a third time.
        { _tag: "Rejected", status: 403, reason: "ExpiredProviderToken" },
      ])
      assert.isTrue(answers.every(Schema.is(ApnsAnswer)))
    }),
  )

  it.effect("fails with ApnsCredentialsRefused, sending once, when APNs refuses the credentials' token", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([
        { status: 403, body: '{"reason":"InvalidProviderToken"}' },
        { status: 403, body: '{"reason":"Forbidden"}' },
      ])
      const error = yield* withApns(key.pem, apns, send().pipe(Effect.flip))
      assert.strictEqual(error._tag, "ApnsCredentialsRefused")
      assert.include(error.message, "InvalidProviderToken")
      assert.strictEqual(apns.asked.length, 1)
      // Another 403 is about the push, and stays an answer.
      const answer = yield* withApns(key.pem, apns, send())
      assert.deepStrictEqual(answer, { _tag: "Rejected", status: 403, reason: "Forbidden" })
    }),
  )

  it.effect("fails with ApnsUnavailable when APNs may take the push later", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([
        "no answer",
        { status: 429, body: '{"reason":"TooManyRequests"}' },
        { status: 500, body: '{"reason":"InternalServerError"}' },
        { status: 503, body: '{"reason":"Shutdown"}' },
        { status: 400, body: "<html>Bad gateway</html>" },
        { status: 400, body: '{"reason":"Bad device token, see https://evil.example"}' },
        "never",
        "stalls",
      ])
      const errors = yield* withApns(
        key.pem,
        apns,
        Effect.gen(function* () {
          const failed: Array<ApnsUnavailable | ApnsCredentialsRefused> = []
          for (let attempt = 0; attempt < 6; attempt += 1) {
            failed.push(yield* send().pipe(Effect.flip))
          }
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const waiting = yield* send().pipe(Effect.flip, Effect.forkChild)
            yield* TestClock.adjust("10 seconds")
            failed.push(yield* Fiber.join(waiting))
          }
          return failed
        }),
      )
      for (const error of errors) {
        assert.strictEqual(error._tag, "ApnsUnavailable")
        assert.include(error.message, error.reason)
      }
      assert.deepStrictEqual(
        errors.map((error) => error.reason),
        [
          "APNs couldn't be reached",
          "APNs answered 429, TooManyRequests",
          "APNs answered 500, InternalServerError",
          "APNs answered 503, Shutdown",
          "APNs answered 400 without a reason",
          "APNs answered 400 without a reason",
          "APNs didn't answer in 10 seconds",
          "APNs didn't answer in 10 seconds",
        ],
      )
    }),
  )

  it.effect("dies on a push no APNs takes, sending nothing: a bundle ID or a collapse ID it can't hold", () =>
    Effect.gen(function* () {
      const key = yield* newKey()
      const apns = fakeApns([])
      for (const wrong of [
        { ...push, bundleId: "com.example.notes\r\nx-injected: 1" },
        { ...push, collapseId: "x".repeat(65) },
      ]) {
        const exit = yield* withApns(key.pem, apns, send(wrong)).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }
      assert.strictEqual(apns.asked.length, 0)
    }),
  )

  it("refuses a device token with anything but hex in it, before or after, so it stays one path segment", () => {
    const token = push.deviceToken
    for (const wrong of ["not hex", "", `../${token}`, `${token}/../../${token}`, `${token}\n`]) {
      assert.isFalse(Schema.is(DeviceToken)(wrong), JSON.stringify(wrong))
    }
  })

  it.effect("fails to build with ApnsCredentialsInvalid for a key or IDs that can't sign APNs's tokens", () =>
    Effect.gen(function* () {
      const p256 = yield* newKey()
      const p384 = yield* newKey({ name: "ECDSA", namedCurve: "P-384" })
      const rsa = yield* newKey({
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      })
      const refused = [
        [credentialsOf(p384.pem), "the key"],
        [credentialsOf(rsa.pem), "the key"],
        [credentialsOf("not a key"), "the key"],
        [{ ...credentialsOf(p256.pem), keyId: "abcde12345" }, "an ID"],
        [{ ...credentialsOf(p256.pem), teamId: "TEAM12345" }, "an ID"],
        // Pasted with what was around them.
        [{ ...credentialsOf(p256.pem), keyId: "ABCDE12345\n" }, "an ID"],
        [{ ...credentialsOf(p256.pem), teamId: " TEAM123456" }, "an ID"],
      ] as const
      for (const [credentials, wrong] of refused) {
        const error = yield* Layer.build(
          Apns.layer(credentials, crypto.subtle).pipe(Layer.provide(fakeApns([]).layer)),
        ).pipe(Effect.scoped, Effect.flip)
        assert.strictEqual(error._tag, "ApnsCredentialsInvalid")
        // Its reason says which is wrong, and its message holds the reason.
        assert.strictEqual(error.reason.includes(" ID"), wrong === "an ID", error.reason)
        assert.include(error.message, error.reason)
      }
    }),
  )
})
