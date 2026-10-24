import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Equal, Exit, Hash, Redacted, Result } from "effect"
import type { Schema } from "effect"
import { Base64, Base64Url } from "effect/encoding"

import type { JwtCrypto, SigningKey } from "../src/index.ts"
import { importSigningKey, signJwt } from "../src/index.ts"

// The runtime's Web Crypto, which tests outside a runtime with its types can't name: the parts
// these tests use.
type KeyAlgorithm =
  | { readonly name: "ECDSA"; readonly namedCurve: "P-256" | "P-384" }
  | {
      readonly name: "RSASSA-PKCS1-v1_5"
      readonly modulusLength: number
      readonly publicExponent: Uint8Array<ArrayBuffer>
      readonly hash: "SHA-256"
    }
declare const crypto: {
  readonly subtle: JwtCrypto & {
    generateKey(
      algorithm: KeyAlgorithm,
      extractable: true,
      keyUsages: Array<"sign" | "verify">,
    ): Promise<{ readonly privateKey: unknown; readonly publicKey: unknown }>
    exportKey(format: "pkcs8", key: unknown): Promise<ArrayBuffer>
    verify(
      algorithm: { readonly name: "ECDSA"; readonly hash: "SHA-256" } | { readonly name: "RSASSA-PKCS1-v1_5" },
      key: unknown,
      signature: Uint8Array<ArrayBuffer>,
      data: Uint8Array<ArrayBuffer>,
    ): Promise<boolean>
  }
}
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

// A key pair of the tests' own, its private key in PKCS #8.
const newKey = (algorithm: KeyAlgorithm) =>
  Effect.gen(function* () {
    const pair = yield* Effect.promise(() => crypto.subtle.generateKey(algorithm, true, ["sign", "verify"]))
    const pkcs8 = new Uint8Array(yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey)))
    return { pkcs8, publicKey: pair.publicKey }
  })
const p256 = { name: "ECDSA", namedCurve: "P-256" } as const
const rsa = (modulusLength: number) =>
  ({ name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: Uint8Array.of(1, 0, 1), hash: "SHA-256" }) as const

// PEM text, 64 characters a line, as OpenSSL, Apple and GitHub write it.
const pemOf = (label: string, der: Uint8Array) => {
  const lines = Base64.encode(der).match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}

// The PKCS #1 key inside a PKCS #8 one, as `openssl rsa -traditional` writes it: the content of the
// OCTET STRING that follows the version and the algorithm.
const pkcs1Of = (pkcs8: Uint8Array) => {
  const element = (at: number) => {
    const first = pkcs8[at + 1] ?? 0
    const lengthBytes = first < 0x80 ? 0 : first & 0x7f
    const length = lengthBytes === 0 ? first : (pkcs8[at + 2] ?? 0) * 256 + (pkcs8[at + 3] ?? 0)
    const start = at + 2 + lengthBytes
    return { start, end: start + length }
  }
  const version = element(element(0).start)
  const algorithm = element(version.end)
  const key = element(algorithm.end)
  return pkcs8.subarray(key.start, key.end)
}

const textOf = (part: string | undefined) =>
  new TextDecoder().decode(Result.getOrElse(Base64Url.decode(part ?? ""), () => new Uint8Array(0)))

// Whether `token`'s signature verifies with `publicKey`, as a JWS verifier checks it.
const verifies = (token: string, publicKey: unknown, algorithm: "ES256" | "RS256") => {
  const [header, claims, signature] = token.split(".")
  const signed = Uint8Array.from(`${header}.${claims}`, (character) => character.charCodeAt(0))
  const bytes = new Uint8Array(Result.getOrElse(Base64Url.decode(signature ?? ""), () => new Uint8Array(0)))
  const verifyAlgorithm =
    algorithm === "ES256" ? ({ name: "ECDSA", hash: "SHA-256" } as const) : ({ name: "RSASSA-PKCS1-v1_5" } as const)
  return Effect.promise(() => crypto.subtle.verify(verifyAlgorithm, publicKey, bytes, signed))
}

const imported = (algorithm: "ES256" | "RS256", text: string) =>
  importSigningKey(crypto.subtle, algorithm, Redacted.make(text))
const reasonFor = (algorithm: "ES256" | "RS256", text: string) =>
  imported(algorithm, text).pipe(
    Effect.flip,
    Effect.map((refused) => refused.reason),
  )
const signed = (key: SigningKey, header: Schema.JsonObject, claims: Schema.JsonObject) => signJwt(key, header, claims)

describe("signing", () => {
  it.effect("signs ES256 tokens whose header names the key's algorithm and whose 64-byte signature verifies", () =>
    Effect.gen(function* () {
      const generated = yield* newKey(p256)
      const key = yield* imported("ES256", pemOf("PRIVATE KEY", generated.pkcs8))
      const token = yield* signed(key, { alg: "none", kid: "ABCDE12345" }, { iss: "TEAM123456", sub: "Zoë · Łódź" })
      const [header, claims, signature] = token.split(".")
      assert.strictEqual(textOf(header), '{"alg":"ES256","kid":"ABCDE12345"}')
      assert.strictEqual(textOf(claims), '{"iss":"TEAM123456","sub":"Zoë · Łódź"}')
      assert.strictEqual(Result.getOrElse(Base64Url.decode(signature ?? ""), () => new Uint8Array(0)).length, 64)
      assert.isTrue(yield* verifies(token, generated.publicKey, "ES256"))
      // One import signs any number of tokens.
      const again = yield* signed(key, { kid: "ABCDE12345" }, { iss: "TEAM123456", n: 2 })
      assert.isTrue(yield* verifies(again, generated.publicKey, "ES256"))
    }),
  )

  it.effect("signs RS256 tokens with a PKCS #1 key, as GitHub gives one, and with a PKCS #8 key", () =>
    Effect.gen(function* () {
      const generated = yield* newKey(rsa(2048))
      const fromPkcs1 = yield* imported("RS256", pemOf("RSA PRIVATE KEY", pkcs1Of(generated.pkcs8)))
      const fromPkcs8 = yield* imported("RS256", pemOf("PRIVATE KEY", generated.pkcs8))
      const first = yield* signed(fromPkcs1, { typ: "JWT" }, { iss: "Iv23liExampleClient" })
      const second = yield* signed(fromPkcs8, { typ: "JWT" }, { iss: "Iv23liExampleClient" })
      assert.strictEqual(textOf(first.split(".")[0]), '{"alg":"RS256","typ":"JWT"}')
      assert.isTrue(yield* verifies(first, generated.publicKey, "RS256"))
      // RS256 is deterministic: the same key, header and claims sign the same token.
      assert.strictEqual(first, second)
    }),
  )

  it.effect("reads the base64 alone, and a PEM whose line breaks are written as \\n, as settings hold them", () =>
    Effect.gen(function* () {
      const generated = yield* newKey(p256)
      for (const text of [
        Base64.encode(generated.pkcs8),
        pemOf("PRIVATE KEY", generated.pkcs8).replaceAll("\n", "\\n"),
      ]) {
        const key = yield* imported("ES256", text)
        assert.isTrue(yield* verifies(yield* signed(key, {}, { iss: "TEAM123456" }), generated.publicKey, "ES256"))
      }
    }),
  )

  it.effect("dies on header fields that change how a token is read, which it doesn't support", () =>
    Effect.gen(function* () {
      const key = yield* imported("ES256", pemOf("PRIVATE KEY", (yield* newKey(p256)).pkcs8))
      for (const header of [{ crit: ["exp"] }, { b64: false }]) {
        const exit = yield* signed(key, header, { iss: "TEAM123456" }).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }
    }),
  )

  it.effect("names the key's algorithm even for a header that changes as it is read", () =>
    Effect.gen(function* () {
      const key = yield* imported("ES256", pemOf("PRIVATE KEY", (yield* newKey(p256)).pkcs8))
      // A header that hides `alg` and `crit` from the first look at each, as a Proxy can.
      const looked = new Set<string | symbol>()
      const changing = new Proxy<Schema.JsonObject>(
        { alg: "none", crit: ["exp"], kid: "ABCDE12345" },
        {
          getOwnPropertyDescriptor: (target, name) => {
            const firstLook = !looked.has(name)
            looked.add(name)
            const hidden = firstLook && (name === "alg" || name === "crit")
            return hidden ? undefined : Reflect.getOwnPropertyDescriptor(target, name)
          },
        },
      )
      const token = yield* signed(key, changing, { iss: "TEAM123456" })
      assert.strictEqual(textOf(token.split(".")[0]), '{"alg":"ES256","kid":"ABCDE12345"}')
    }),
  )
})

describe("importing", () => {
  it.effect("refuses what isn't one supported key, saying why without the key", () =>
    Effect.gen(function* () {
      const ec = yield* newKey(p256)
      const rsaKey = yield* newKey(rsa(2048))
      const p384 = yield* newKey({ name: "ECDSA", namedCurve: "P-384" })
      const pem = pemOf("PRIVATE KEY", ec.pkcs8)
      const cases: ReadonlyArray<readonly ["ES256" | "RS256", string, string]> = [
        ["ES256", "not a key!", "The key isn't base64 text, with or without PEM armor"],
        ["ES256", `${pem}${pem}`, "The text holds 2 PEM blocks; give the one key alone"],
        [
          "ES256",
          pemOf("ENCRYPTED PRIVATE KEY", ec.pkcs8),
          "The key is encrypted; decrypt it first, such as with openssl pkcs8 -topk8 -nocrypt",
        ],
        [
          "ES256",
          pem.replace("-----BEGIN PRIVATE KEY-----\n", "$&Proc-Type: 4,ENCRYPTED\n"),
          "The key is encrypted; decrypt it first, such as with openssl pkcs8 -topk8 -nocrypt",
        ],
        [
          "ES256",
          pemOf("PUBLIC KEY", ec.pkcs8),
          "The PEM block is labelled PUBLIC KEY, not a private key ES256 can sign with",
        ],
        ["ES256", "A".repeat(70_000), "The key's text is over 64 KiB, longer than any ES256 or RS256 key"],
        [
          "ES256",
          pemOf("PRIVATE KEY", p384.pkcs8),
          "The key isn't a P-256 key in PKCS #8 (BEGIN PRIVATE KEY), as Apple's .p8 files hold",
        ],
        [
          "ES256",
          pemOf("PRIVATE KEY", rsaKey.pkcs8),
          "The key isn't a P-256 key in PKCS #8 (BEGIN PRIVATE KEY), as Apple's .p8 files hold",
        ],
        [
          "RS256",
          pem,
          "The key isn't an unencrypted RSA key in PKCS #1 (BEGIN RSA PRIVATE KEY) or PKCS #8 (BEGIN PRIVATE KEY)",
        ],
        // PKCS #1 needs its armor, which names it.
        [
          "RS256",
          Base64.encode(pkcs1Of(rsaKey.pkcs8)),
          "The key isn't an unencrypted RSA key in PKCS #1 (BEGIN RSA PRIVATE KEY) or PKCS #8 (BEGIN PRIVATE KEY)",
        ],
      ]
      for (const [algorithm, text, reason] of cases) {
        assert.strictEqual(yield* reasonFor(algorithm, text), reason)
      }
      const refused = yield* imported("ES256", "not a key!").pipe(Effect.flip)
      assert.strictEqual(refused._tag, "InvalidSigningKey")
      assert.strictEqual(
        refused.message,
        "The ES256 key was refused: The key isn't base64 text, with or without PEM armor",
      )
    }),
  )

  it.effect("refuses an RSA key under 2048 bits, which RS256 forbids", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* reasonFor("RS256", pemOf("PRIVATE KEY", (yield* newKey(rsa(1024))).pkcs8)),
        "The RSA key has 1024 bits; RS256 takes 2048 to 8192 (RFC 7518, section 3.3)",
      )
    }),
  )

  it.effect("dies, rather than blaming the key, when what it was given isn't crypto.subtle", () =>
    Effect.gen(function* () {
      const notSubtle: JwtCrypto = {
        importKey: () => Promise.reject(new TypeError("crypto.subtle is undefined")),
        sign: () => Promise.reject(new TypeError("crypto.subtle is undefined")),
      }
      const pem = pemOf("PRIVATE KEY", (yield* newKey(p256)).pkcs8)
      const exit = yield* importSigningKey(notSubtle, "ES256", Redacted.make(pem)).pipe(Effect.exit)
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
    }),
  )

  it.effect("gives a frozen handle that holds no key, equal only to itself in Effect's Equal and Hash", () =>
    Effect.gen(function* () {
      const first = yield* imported("ES256", pemOf("PRIVATE KEY", (yield* newKey(p256)).pkcs8))
      const second = yield* imported("ES256", pemOf("PRIVATE KEY", (yield* newKey(p256)).pkcs8))
      assert.isTrue(Object.isFrozen(first))
      // What code holding it can reach: the algorithm, and nothing that leads to the key.
      assert.deepStrictEqual(Object.keys(first), ["algorithm"])
      assert.isFalse(Equal.equals(first, second))
      assert.notStrictEqual(Hash.hash(first), Hash.hash(second))
      assert.isTrue(first[Equal.symbol](first))
      // The same in another copy of Effect, which calls the same protocols.
      assert.isFalse(first[Equal.symbol](second))
    }),
  )
})
