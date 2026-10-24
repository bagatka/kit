import { Effect, Redacted } from "effect"
import { Base64 } from "effect/encoding"

import type { AppStoreConnectCrypto } from "../src/index.ts"

// The runtime's Web Crypto, which tests outside a runtime with its types can't name: the parts
// these tests use.
declare const crypto: {
  readonly subtle: AppStoreConnectCrypto & {
    generateKey(
      algorithm: { readonly name: "ECDSA"; readonly namedCurve: "P-256" },
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

/** The runtime's Web Crypto, as a host passes it. */
export const subtle = crypto.subtle

/** A key of the tests' own, as App Store Connect's `.p8` file holds one, and its public half. */
export const newKey = Effect.gen(function* () {
  const pair = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const der = new Uint8Array(exported)
  const pem = `-----BEGIN PRIVATE KEY-----\n${Base64.encode(der)}\n-----END PRIVATE KEY-----\n`
  return { pem, publicKey: pair.publicKey }
})

/** An API key's credentials, with `pem` as its key. */
export const credentials = (pem: string) => ({
  key: Redacted.make(pem),
  keyId: "2X9R4HXF34",
  issuerId: "57246542-96fe-1a63-e053-0824d011072a",
})
