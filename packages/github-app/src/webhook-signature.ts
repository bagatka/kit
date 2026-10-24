import { Effect, Redacted, Result } from "effect"
import { Hex } from "effect/encoding"

// The runtime's TextEncoder, a web standard in every runtime this runs on, which the package's
// types don't name.
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }

/**
 * The part of the platform's Web Crypto, `crypto.subtle`, that webhooks are checked with: in
 * Workers, browsers, Deno, Bun, and Node.
 */
export interface WebhookCrypto {
  importKey(
    format: "raw",
    keyData: Uint8Array<ArrayBuffer>,
    algorithm: { readonly name: "HMAC"; readonly hash: "SHA-256" },
    extractable: false,
    keyUsages: Array<"sign">,
  ): Promise<unknown>
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
}

const hmacSha256 = { name: "HMAC", hash: "SHA-256" } as const
const prefix = "sha256="
// One spelling of a signature, as GitHub writes it: `sha256=` and 64 lowercase hex digits.
const signatureShape = /^sha256=[0-9a-f]{64}$/

/**
 * Whether `signature`, a delivery's `X-Hub-Signature-256` header as the request has it, signs
 * `body`, the delivery's bytes as they came, with the webhook's `secret`: `sha256=` and the hex of
 * their HMAC-SHA256, in lowercase, as GitHub writes it. Anything else, a missing header (`null`)
 * included, is `false`. The two MACs are compared in time that depends on their length alone. A secret Web Crypto can't key
 * HMAC with, such as an empty one, is a defect.
 */
export const verifyWebhook = Effect.fn("verifyWebhook")(function* (
  crypto: WebhookCrypto,
  secret: Redacted.Redacted,
  body: Uint8Array,
  signature: unknown,
) {
  const presented =
    typeof signature === "string" && signatureShape.test(signature)
      ? Hex.decode(signature.slice(prefix.length))
      : undefined
  if (presented === undefined || Result.isFailure(presented)) {
    return false
  }
  const key = yield* Effect.tryPromise({
    try: () => crypto.importKey("raw", new TextEncoder().encode(Redacted.value(secret)), hmacSha256, false, ["sign"]),
    catch: () => "The webhook's secret can't key HMAC-SHA256: it is empty, or the platform has no HMAC",
  })
  const mac = yield* Effect.tryPromise({
    // A copy, on a buffer of its own, as Web Crypto takes it.
    try: () => crypto.sign("HMAC", key, new Uint8Array(body)),
    catch: () => "Web Crypto couldn't sign the webhook's body with HMAC-SHA256",
  })
  return sameBytes(new Uint8Array(mac), presented.success)
}, Effect.orDie)

// Whether two byte strings are equal, looking at every byte whatever differs, so how long it takes
// says nothing about where they differ.
const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  const sameLength = a.length === b.length
  const difference = a.reduce((bits, byte, index) => bits | (byte ^ (b[index] ?? 0)), 0)
  return sameLength && difference === 0
}
