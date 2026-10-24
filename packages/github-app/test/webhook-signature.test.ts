import { assert, describe, it } from "@effect/vitest"
import { Effect, Redacted, Result } from "effect"
import { Hex } from "effect/encoding"

import type { WebhookCrypto } from "../src/index.ts"
import { verifyWebhook } from "../src/index.ts"
import { subtle, utf8 } from "./web-crypto.ts"

// GitHub's own example, from "Validating webhook deliveries".
const secret = Redacted.make("It's a Secret to Everybody")
const body = utf8("Hello, World!")
const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17"

// A platform whose HMAC answers `signed`, whatever it is asked.
const signing = (signed: Uint8Array): WebhookCrypto => ({
  importKey: () => Promise.resolve({}),
  sign: () => Promise.resolve(Uint8Array.from(signed).buffer),
})

describe("verifyWebhook", () => {
  it.effect("takes a delivery its secret signed, as GitHub's example has it", () =>
    Effect.gen(function* () {
      const verified = yield* verifyWebhook(subtle, secret, body, signature)
      assert.isTrue(verified)
    }),
  )

  it.effect("refuses a tampered body, a tampered signature, a wrong secret, and a signature of the wrong length", () =>
    Effect.gen(function* () {
      const tamperedSignature = `${signature.slice(0, -1)}8`
      const results = yield* Effect.all([
        verifyWebhook(subtle, secret, utf8("Hello, World?"), signature),
        verifyWebhook(subtle, secret, body, tamperedSignature),
        verifyWebhook(subtle, Redacted.make("Another secret"), body, signature),
        verifyWebhook(subtle, secret, body, signature.slice(0, -2)),
        verifyWebhook(subtle, secret, body, `${signature}00`),
        verifyWebhook(subtle, secret, body, signature.slice("sha256=".length)),
        verifyWebhook(subtle, secret, body, "sha256=not hex at all"),
        // The same MAC in capitals: one spelling only, as GitHub writes it.
        verifyWebhook(subtle, secret, body, signature.toUpperCase().replace("SHA256=", "sha256=")),
        // No header at all, as `headers.get` answers then.
        verifyWebhook(subtle, secret, body, null),
        // Something that isn't a header, though it prints as the right one.
        verifyWebhook(subtle, secret, body, { toString: () => signature }),
      ])
      assert.deepStrictEqual(results, [false, false, false, false, false, false, false, false, false, false])
    }),
  )

  it.effect("compares the whole MAC, never a part of it, whatever the platform signs", () =>
    Effect.gen(function* () {
      const mac = Result.getOrElse(Hex.decode(signature.slice("sha256=".length)), () => new Uint8Array(0))
      const results = yield* Effect.all([
        verifyWebhook(signing(mac), secret, body, signature),
        // A MAC a byte longer, and the signature that spells it.
        verifyWebhook(signing(Uint8Array.of(...mac, 0)), secret, body, `${signature}00`),
        // A MAC a byte shorter, and the signature whose first bytes it is.
        verifyWebhook(signing(mac.subarray(0, 31)), secret, body, signature),
      ])
      assert.deepStrictEqual(results, [true, false, false])
    }),
  )
})
