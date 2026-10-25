import { Effect, Schema } from "effect"
import { Base64Url } from "effect/encoding"

import { coseKeyOf, publicKeyOf } from "./cose-key.ts"
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthnCrypto } from "./webauthn.ts"

/**
 * The part of the Web Crypto API a software authenticator makes and signs passkeys with: `crypto`
 * in Workers, browsers, Deno, Bun, and Node.
 */
export interface AuthenticatorCrypto {
  readonly subtle: WebAuthnCrypto & {
    generateKey(
      algorithm: { readonly name: "ECDSA"; readonly namedCurve: "P-256" },
      extractable: true,
      keyUsages: Array<"sign" | "verify">,
    ): Promise<unknown>
    exportKey(format: "raw", key: unknown): Promise<unknown>
    sign(
      algorithm: { readonly name: "ECDSA"; readonly hash: "SHA-256" },
      key: unknown,
      data: Uint8Array<ArrayBuffer>,
    ): Promise<ArrayBuffer>
  }
  getRandomValues(array: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>
}

/** Where a ceremony runs, and with what challenge: what a browser puts in the client data. */
export interface Ceremony {
  readonly challenge: string
  readonly origin: string
  readonly rpId: string
}

/** An authenticator in software and its one passkey, by `id`. */
export interface SoftwareAuthenticator {
  readonly id: string
  /**
   * Makes the passkey for `ceremony`, for the account whose user handle is `account.userHandle`, as
   * a browser's `credential.toJSON()` gives it: synced, as a phone's or a password manager's is,
   * with an attestation object of format `none`, and every other field a browser sends, such as
   * `rawId`, `authenticatorData` and `publicKey`, though its type names only those
   * `verifyRegistration` reads. `verified: false` leaves the person unverified, for tests of
   * refusals.
   */
  readonly register: (
    ceremony: Ceremony,
    account: { readonly userHandle: string; readonly verified?: boolean },
  ) => Effect.Effect<RegistrationResponseJSON>
  /**
   * Signs in for `ceremony`, as a browser's `credential.toJSON()` gives it, naming the account it
   * was registered for. `signCount` sets the counter, which synced passkeys keep at 0; `type` sets
   * the client data's type, for tests of refusals.
   */
  readonly authenticate: (
    ceremony: Ceremony,
    options?: { readonly signCount?: number; readonly type?: string },
  ) => Effect.Effect<AuthenticationResponseJSON>
}

// The authenticator data's flags: the person present (0x01) and verified (0x04), the passkey
// eligible for backup (0x08) and backed up (0x10), as synced passkeys are; 0x40 marks a credential.
const signInFlags = 0x1d
const registrationFlags = 0x5d

const ClientDataText = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, challenge: Schema.String, origin: Schema.String, crossOrigin: Schema.Boolean }),
)

declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }

const text = (value: string) => new TextEncoder().encode(value)
const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}
const sha256 = (crypto: AuthenticatorCrypto, bytes: Uint8Array<ArrayBuffer>) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(Effect.map((hash) => new Uint8Array(hash)))
const counter = (value: number) =>
  Uint8Array.of(value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)

// The client data a browser makes for a ceremony of `type`, as JSON.
const clientData = (type: string, ceremony: Ceremony) =>
  Schema.encodeEffect(ClientDataText)({
    type,
    challenge: ceremony.challenge,
    origin: ceremony.origin,
    crossOrigin: false,
  }).pipe(Effect.orDie, Effect.map(text))

// A CBOR byte string's head (RFC 8949, section 3) for `length` bytes, up to 65,535.
const byteStringHead = (length: number) => {
  if (length < 24) {
    return Uint8Array.of(0x40 | length)
  }
  return length < 256 ? Uint8Array.of(0x58, length) : Uint8Array.of(0x59, length >> 8, length & 0xff)
}

// The attestation object a device writes without attestation (WebAuthn, section 8.7): format
// `none`, an empty statement, and the authenticator data, in CTAP2's canonical order.
const noneAttestationOf = (authenticatorData: Uint8Array) =>
  concat(
    Uint8Array.of(0xa3, 0x63),
    text("fmt"),
    Uint8Array.of(0x64),
    text("none"),
    Uint8Array.of(0x67),
    text("attStmt"),
    Uint8Array.of(0xa0, 0x68),
    text("authData"),
    byteStringHead(authenticatorData.length),
    authenticatorData,
  )

// An ECDSA signature as Web Crypto makes it, r and s, as authenticators send it: DER.
const derOf = (raw: Uint8Array) => {
  const integer = (value: Uint8Array) => {
    let start = 0
    while (start < value.length - 1 && value[start] === 0 && (value[start + 1] ?? 0) < 0x80) {
      start += 1
    }
    const trimmed = value.subarray(start)
    const padded = (trimmed[0] ?? 0) >= 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
    return concat(Uint8Array.of(0x02, padded.length), padded)
  }
  const body = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)))
  return concat(Uint8Array.of(0x30, body.length), body)
}

// What generating a key pair gives: two keys, whatever the platform's types for them.
const KeyPair = Schema.Struct({ privateKey: Schema.Unknown, publicKey: Schema.Unknown })

/**
 * An authenticator in software, holding one passkey: it makes and signs as a phone's or a password
 * manager's does, with the person verified unless told otherwise, and writes its key as devices do.
 * For tests of the sites that check passkeys; its key lives in memory, and it can sign only with
 * its own key, so it can't stand in for anyone else's.
 */
export const softwareAuthenticator = Effect.fn("softwareAuthenticator")(function* (crypto: AuthenticatorCrypto) {
  const generated = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )
  const pair = yield* Schema.decodeUnknownEffect(KeyPair)(generated).pipe(Effect.orDie)
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("raw", pair.publicKey))
  if (!(exported instanceof ArrayBuffer) || exported.byteLength !== 65) {
    return yield* Effect.die("Web Crypto exported no uncompressed P-256 point")
  }
  const coseKey = coseKeyOf(new Uint8Array(exported))
  const spki = publicKeyOf(coseKey)?.spki
  if (spki === undefined) {
    return yield* Effect.die("A COSE key written here couldn't be read back")
  }
  const credentialId = crypto.getRandomValues(new Uint8Array(16))
  const id = Base64Url.encode(credentialId)
  // The account it was registered for; none until it is.
  let registeredFor = ""

  const register = (ceremony: Ceremony, account: { readonly userHandle: string; readonly verified?: boolean }) =>
    Effect.gen(function* () {
      registeredFor = account.userHandle
      const flags = account.verified === false ? registrationFlags & ~0x04 : registrationFlags
      const authenticatorData = concat(
        yield* sha256(crypto, text(ceremony.rpId)),
        Uint8Array.of(flags),
        counter(0),
        // The authenticator's model, AAGUID: zeros, as most synced passkeys send.
        new Uint8Array(16),
        Uint8Array.of(0, credentialId.length),
        credentialId,
        coseKey,
      )
      // What a browser's toJSON() gives, every field, as sites receive it.
      const response = {
        id,
        rawId: id,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: Base64Url.encode(yield* clientData("webauthn.create", ceremony)),
          attestationObject: Base64Url.encode(noneAttestationOf(authenticatorData)),
          authenticatorData: Base64Url.encode(authenticatorData),
          publicKey: Base64Url.encode(spki),
          publicKeyAlgorithm: -7,
          transports: ["hybrid", "internal"],
        },
      }
      return response
    })

  const authenticate = (ceremony: Ceremony, options: { readonly signCount?: number; readonly type?: string } = {}) =>
    Effect.gen(function* () {
      const data = yield* clientData(options.type ?? "webauthn.get", ceremony)
      const authenticatorData = concat(
        yield* sha256(crypto, text(ceremony.rpId)),
        Uint8Array.of(signInFlags),
        counter(options.signCount ?? 0),
      )
      const signed = concat(authenticatorData, yield* sha256(crypto, data))
      const raw = new Uint8Array(
        yield* Effect.promise(() => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, signed)),
      )
      const response = {
        id,
        rawId: id,
        type: "public-key",
        authenticatorAttachment: "platform",
        clientExtensionResults: {},
        response: {
          clientDataJSON: Base64Url.encode(data),
          authenticatorData: Base64Url.encode(authenticatorData),
          signature: Base64Url.encode(derOf(raw)),
          userHandle: registeredFor,
        },
      }
      return response
    })

  const authenticator: SoftwareAuthenticator = { id, register, authenticate }
  return authenticator
})
