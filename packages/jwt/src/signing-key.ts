import { Effect, Equal, Hash, Predicate, Redacted, Result, Schema } from "effect"

import { derOfKey } from "./key-text.ts"
import { wrappedInPkcs8 } from "./pkcs8.ts"

/**
 * What a JWT is signed with: `ES256`, ECDSA on P-256 with SHA-256, as Apple's `.p8` keys sign; or
 * `RS256`, RSASSA-PKCS1-v1_5 with SHA-256, as a GitHub App's or a Google service account's key signs.
 */
export const JwtAlgorithm = Schema.Literals(["ES256", "RS256"])
export type JwtAlgorithm = typeof JwtAlgorithm.Type

/**
 * The part of the Web Crypto API this package imports keys and signs with: `crypto.subtle` in
 * Workers, browsers, Deno, Bun, and Node.
 */
export interface JwtCrypto {
  importKey(
    format: "pkcs8",
    keyData: Uint8Array<ArrayBuffer>,
    algorithm:
      | { readonly name: "ECDSA"; readonly namedCurve: "P-256" }
      | { readonly name: "RSASSA-PKCS1-v1_5"; readonly hash: "SHA-256" },
    extractable: false,
    keyUsages: Array<"sign">,
  ): Promise<unknown>
  sign(
    algorithm: { readonly name: "ECDSA"; readonly hash: "SHA-256" } | { readonly name: "RSASSA-PKCS1-v1_5" },
    key: unknown,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<ArrayBuffer>
}

// Only `importSigningKey` makes a `SigningKey`, so one built by hand doesn't type-check.
const signingKeyBrand: unique symbol = Symbol("SigningKey")

/**
 * A private key imported once, to sign any number of JWTs: a handle that can sign and holds
 * nothing else. Importing is the slow part, an RSA key's especially, so keep it for as long as the
 * key is in use. It is frozen, only `importSigningKey` makes one, and the key can't be reached
 * through it.
 */
export interface SigningKey extends Equal.Equal {
  /** What every token it signs names as its `alg`. */
  readonly algorithm: JwtAlgorithm
  readonly [signingKeyBrand]: true
}

/** The platform's key behind a `SigningKey`, and the platform's function that signs with it. */
interface PlatformKey {
  readonly cryptoKey: unknown
  readonly sign: JwtCrypto["sign"]
}

// Kept here, never on the `SigningKey` itself: Node's and Bun's `KeyObject.from` export even a
// key Web Crypto calls non-extractable, so code that holds a `SigningKey` must not reach the
// platform's key. Nothing outside this file reads it: `signWith` signs with it. Its functions are
// bound when this file loads, so patching `WeakMap.prototype` later can't intercept them. A key
// made by another copy of this package isn't here.
const platformKeys = new WeakMap<SigningKey, PlatformKey>()
const platformKeyOf = platformKeys.get.bind(platformKeys)
const setPlatformKey = platformKeys.set.bind(platformKeys)

/**
 * The key can't sign with its algorithm. `reason` says why, for logs, and never holds the key.
 * Importing it again won't help: report the key.
 */
export class InvalidSigningKey extends Schema.TaggedError<InvalidSigningKey>()("InvalidSigningKey", {
  algorithm: JwtAlgorithm,
  reason: Schema.String,
}) {
  override get message(): string {
    return `The ${this.algorithm} key was refused: ${this.reason}`
  }
}

const importAlgorithm = {
  ES256: { name: "ECDSA", namedCurve: "P-256" },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
} as const

const expectedForm = {
  ES256: "a P-256 key in PKCS #8 (BEGIN PRIVATE KEY), as Apple's .p8 files hold",
  RS256: "an unencrypted RSA key in PKCS #1 (BEGIN RSA PRIVATE KEY) or PKCS #8 (BEGIN PRIVATE KEY)",
} as const

// RFC 7518, section 3.3: RS256 keys are 2048 bits or more. Past 8192, every signature costs tens of
// milliseconds, which no service asks for.
const rsaBits = { least: 2048, most: 8192 }

/**
 * Imports `key`, a PEM's text with or without its armor and line breaks, to sign with `algorithm`.
 * ES256 takes a P-256 key in PKCS #8 (`BEGIN PRIVATE KEY`), the form of Apple's `.p8` files. RS256
 * takes an RSA key of 2048 to 8192 bits in PKCS #1 (`BEGIN RSA PRIVATE KEY`), as GitHub gives a
 * GitHub App's, or in PKCS #8, as Google gives a service account's; base64 without armor is read as
 * PKCS #8. The platform's Web Crypto checks the key itself. Fails with `InvalidSigningKey` for
 * anything else: text that isn't one such key (two PEM blocks, a public key, an encrypted key, more
 * than 64 KiB), a key for the other algorithm or another curve, or an RSA key of another size.
 */
export const importSigningKey = Effect.fn("importSigningKey")(function* (
  crypto: JwtCrypto,
  algorithm: JwtAlgorithm,
  key: Redacted.Redacted,
) {
  const parsed = derOfKey(Redacted.value(key), algorithm)
  if (Result.isFailure(parsed)) {
    return yield* new InvalidSigningKey({ algorithm, reason: parsed.failure })
  }
  // Web Crypto imports PKCS #8 alone, so an RSA key in PKCS #1 is wrapped in it first.
  const pkcs8 = parsed.success.form === "pkcs1" ? wrappedInPkcs8(parsed.success.der) : parsed.success.der
  const imported = yield* Effect.tryPromise(() =>
    crypto.importKey("pkcs8", pkcs8, importAlgorithm[algorithm], false, ["sign"]),
  ).pipe(Effect.result)
  if (Result.isFailure(imported)) {
    // The platform says `DataError` for bytes that aren't such a key (Web Crypto, "importKey").
    // Anything else, such as an object that isn't `crypto.subtle`, is a bug of the caller's.
    const cause = imported.failure.cause
    const notAKey = Predicate.hasProperty(cause, "name") && cause.name === "DataError"
    if (notAKey) {
      return yield* new InvalidSigningKey({ algorithm, reason: `The key isn't ${expectedForm[algorithm]}` })
    }
    return yield* Effect.die(cause)
  }
  if (algorithm === "RS256") {
    const bits = modulusLengthOf(imported.success)
    if (bits === undefined || bits < rsaBits.least || bits > rsaBits.most) {
      return yield* new InvalidSigningKey({
        algorithm,
        reason: `The RSA key has ${bits ?? "an unknown number of"} bits; RS256 takes ${rsaBits.least} to ${rsaBits.most} (RFC 7518, section 3.3)`,
      })
    }
  }
  // Equal only to itself, and hashed by identity, in every copy of Effect: Effect compares plain
  // objects by their fields, and a cache of tokens by key would otherwise hand one key's token out
  // for another's. The protocols' keys are strings every copy of Effect shares; they are hidden from
  // enumeration, so the handle shows, copies, and serializes as its algorithm alone.
  const signingKey: SigningKey = {
    algorithm,
    [signingKeyBrand]: true,
    [Equal.symbol]: (that: Equal.Equal) => that === signingKey,
    [Hash.symbol]: () => Hash.random(signingKey),
  }
  Object.defineProperty(signingKey, Equal.symbol, { enumerable: false })
  Object.defineProperty(signingKey, Hash.symbol, { enumerable: false })
  Object.freeze(signingKey)
  // `sign` is taken now, so patching Web Crypto later can't catch the key.
  setPlatformKey(signingKey, { cryptoKey: imported.success, sign: crypto.sign.bind(crypto) })
  return signingKey
})

// An RSA key's size in bits, as the platform's key states it (`algorithm.modulusLength`).
const modulusLengthOf = (cryptoKey: unknown): number | undefined => {
  const keyAlgorithm = Predicate.hasProperty(cryptoKey, "algorithm") ? cryptoKey.algorithm : undefined
  const bits = Predicate.hasProperty(keyAlgorithm, "modulusLength") ? keyAlgorithm.modulusLength : undefined
  return Predicate.isNumber(bits) ? bits : undefined
}

const signAlgorithm = {
  ES256: { name: "ECDSA", hash: "SHA-256" },
  RS256: { name: "RSASSA-PKCS1-v1_5" },
} as const

/**
 * `data` signed with `key`: for `signJwt`, the one place the platform's key is used. Dies for a key
 * another copy of this package made, which has no platform key here.
 */
export const signWith = Effect.fnUntraced(function* (key: SigningKey, data: Uint8Array<ArrayBuffer>) {
  const platformKey = platformKeyOf(key)
  if (platformKey === undefined) {
    return yield* Effect.die("signJwt takes a SigningKey that this copy of @bagatka/jwt's importSigningKey made")
  }
  const signature = yield* Effect.promise(() =>
    platformKey.sign(signAlgorithm[key.algorithm], platformKey.cryptoKey, data),
  )
  return new Uint8Array(signature)
})
