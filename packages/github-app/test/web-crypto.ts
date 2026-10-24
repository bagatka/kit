import { Effect, Result } from "effect"
import { Base64, Base64Url } from "effect/encoding"

import type { GitHubAppCrypto, WebhookCrypto } from "../src/index.ts"

// The runtime's Web Crypto and TextDecoder, which tests outside a runtime with its types can't name:
// the parts these tests use.
declare const crypto: {
  readonly subtle: GitHubAppCrypto &
    WebhookCrypto & {
      generateKey(
        algorithm: {
          readonly name: "RSASSA-PKCS1-v1_5"
          readonly modulusLength: number
          readonly publicExponent: Uint8Array
          readonly hash: "SHA-256"
        },
        extractable: true,
        keyUsages: Array<"sign" | "verify">,
      ): Promise<{ readonly privateKey: unknown; readonly publicKey: unknown }>
      exportKey(format: "pkcs8", key: unknown): Promise<ArrayBuffer>
      verify(
        algorithm: { readonly name: "RSASSA-PKCS1-v1_5" },
        key: unknown,
        signature: Uint8Array,
        data: Uint8Array,
      ): Promise<boolean>
    }
}
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }

/** The runtime's Web Crypto, as a host passes it. */
export const subtle = crypto.subtle

/** Text as UTF-8 bytes. */
export const utf8 = (text: string) => new TextEncoder().encode(text)

const pemOf = (label: string, der: Uint8Array) => {
  const lines = Base64.encode(der).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

// One DER element at `at`: its tag, where its content starts, and where it ends.
const elementAt = (der: Uint8Array, at: number) => {
  const firstLengthByte = der[at + 1] ?? 0
  const lengthBytes = firstLengthByte < 0x80 ? 0 : firstLengthByte & 0x7f
  const length =
    lengthBytes === 0
      ? firstLengthByte
      : Array.from(der.subarray(at + 2, at + 2 + lengthBytes)).reduce((value, byte) => value * 256 + byte, 0)
  const contentStart = at + 2 + lengthBytes
  return { tag: der[at], contentStart, end: contentStart + length }
}

// The PKCS #1 key inside a PKCS #8 one, as GitHub gives an app's key: the content of
// PrivateKeyInfo's OCTET STRING, after its version and its algorithm.
const pkcs1Of = (pkcs8: Uint8Array) => {
  const info = elementAt(pkcs8, 0)
  const version = elementAt(pkcs8, info.contentStart)
  const algorithm = elementAt(pkcs8, version.end)
  const key = elementAt(pkcs8, algorithm.end)
  return pkcs8.subarray(key.contentStart, key.end)
}

/** An app's private key of the tests' own: its PKCS #1 PEM, as GitHub gives it, its PKCS #8 PEM, and its public half. */
export const newAppKey = Effect.gen(function* () {
  const pair = yield* Effect.promise(() =>
    subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    ),
  )
  const pkcs8 = new Uint8Array(yield* Effect.promise(() => subtle.exportKey("pkcs8", pair.privateKey)))
  return {
    pkcs1: pemOf("RSA PRIVATE KEY", pkcs1Of(pkcs8)),
    pkcs8: pemOf("PRIVATE KEY", pkcs8),
    publicKey: pair.publicKey,
  }
})

const textOf = (part: string) =>
  new TextDecoder().decode(Result.getOrElse(Base64Url.decode(part), () => new Uint8Array(0)))

/** A JWT's header and claims as text, and whether its signature verifies with `publicKey`. */
export const openJwt = (jwt: string, publicKey: unknown) =>
  Effect.gen(function* () {
    const [header = "", claims = "", signature = ""] = jwt.split(".")
    const verifies = yield* Effect.promise(() =>
      subtle.verify(
        { name: "RSASSA-PKCS1-v1_5" },
        publicKey,
        Result.getOrElse(Base64Url.decode(signature), () => new Uint8Array(0)),
        utf8(`${header}.${claims}`),
      ),
    )
    return { header: textOf(header), claims: textOf(claims), verifies }
  })
