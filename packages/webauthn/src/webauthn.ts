import { Crypto, Effect, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"

import { publicKeyOf } from "./cose-key.ts"
import { rawSignatureOf } from "./der-signature.ts"

/**
 * The part of the Web Crypto API this package checks passkeys with: `crypto.subtle` in Workers,
 * browsers, Deno, Bun, and Node.
 */
export interface WebAuthnCrypto {
  digest(algorithm: "SHA-256", data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>
  importKey(
    format: "spki",
    keyData: Uint8Array<ArrayBuffer>,
    algorithm: { readonly name: "ECDSA"; readonly namedCurve: "P-256" },
    extractable: false,
    keyUsages: Array<"verify">,
  ): Promise<unknown>
  verify(
    algorithm: { readonly name: "ECDSA"; readonly hash: "SHA-256" },
    key: unknown,
    signature: Uint8Array<ArrayBuffer>,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<boolean>
}

/** Who a new passkey is for, as the person's device shows it. */
export interface RegistrationInput {
  /** The relying party: the site, by its hostname (`id`, `example.com`), and the name people know it by. */
  readonly rp: { readonly id: string; readonly name: string }
  /**
   * The account. `id` is its user handle: base64url of 1 to 64 random bytes made once per account,
   * never an email or a name, since devices keep it and send it back. `name` is what the person
   * knows the account by, such as their email, and `displayName` how the device shows it.
   */
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string }
  /** IDs of the passkeys the person already has here, so a device doesn't make a second one. */
  readonly excludeIds: ReadonlyArray<string>
}

const PasskeyCredential = Schema.Struct({ type: Schema.String, id: Schema.String }).annotate({
  identifier: "PasskeyCredential",
})

/**
 * Options for `navigator.credentials.create()`, as `PublicKeyCredential.parseCreationOptionsFromJSON`
 * reads them, and as an app passes them to the platform's passkey request.
 */
export const RegistrationOptions = Schema.Struct({
  rp: Schema.Struct({ id: Schema.String, name: Schema.String }).annotate({ identifier: "PasskeySite" }),
  user: Schema.Struct({ id: Schema.String, name: Schema.String, displayName: Schema.String }).annotate({
    identifier: "PasskeyUser",
  }),
  challenge: Schema.String,
  pubKeyCredParams: Schema.Array(
    Schema.Struct({ type: Schema.String, alg: Schema.Int }).annotate({ identifier: "PasskeyAlgorithm" }),
  ),
  timeout: Schema.Int,
  excludeCredentials: Schema.Array(PasskeyCredential),
  authenticatorSelection: Schema.Struct({
    residentKey: Schema.String,
    requireResidentKey: Schema.Boolean,
    userVerification: Schema.String,
  }).annotate({ identifier: "PasskeySelection" }),
  attestation: Schema.String,
}).annotate({ identifier: "PasskeyRegistrationOptions" })
export type RegistrationOptions = typeof RegistrationOptions.Type

/**
 * Options for `navigator.credentials.get()`, as `PublicKeyCredential.parseRequestOptionsFromJSON`
 * reads them, and as an app passes them to the platform's passkey request.
 */
export const AuthenticationOptions = Schema.Struct({
  challenge: Schema.String,
  rpId: Schema.String,
  timeout: Schema.Int,
  userVerification: Schema.String,
  allowCredentials: Schema.Array(PasskeyCredential),
}).annotate({ identifier: "PasskeyAuthenticationOptions" })
export type AuthenticationOptions = typeof AuthenticationOptions.Type

/**
 * The options that make a passkey: discoverable, verified by the person (Face ID, Touch ID, a PIN),
 * ES256, and without attestation; with a new challenge of 32 random bytes from Effect's `Crypto`,
 * which the caller provides. Keep the challenge with the account it is for, and use it once, within
 * the 5 minutes devices wait. A `user.id` that isn't 1 to 64 bytes of canonical base64url is a
 * bug, and dies.
 */
export const registrationOptions = Effect.fn("registrationOptions")(function* (input: RegistrationInput) {
  if (!isUserHandle(input.user.id)) {
    return yield* Effect.die("registrationOptions takes a user.id of 1 to 64 random bytes in canonical base64url")
  }
  const challenge = yield* newChallenge
  const options: RegistrationOptions = {
    rp: { id: input.rp.id, name: input.rp.name },
    user: { id: input.user.id, name: input.user.name, displayName: input.user.displayName },
    challenge,
    // Not handled: authenticators without ES256, which some Windows Hello setups lack; they can't
    // make a passkey here, and the browser says so.
    pubKeyCredParams: [{ type: "public-key", alg: es256 }],
    timeout: ceremonyMs,
    excludeCredentials: input.excludeIds.map((id) => ({ type: "public-key", id })),
    authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
    attestation: "none",
  }
  return options
})

/**
 * The options that sign in with any of the site's passkeys, verified by the person, with a new
 * challenge of 32 random bytes from Effect's `Crypto`. Keep the challenge, and use it once, within
 * the 5 minutes devices wait.
 */
export const authenticationOptions = Effect.fn("authenticationOptions")(function* (input: {
  /** The site's hostname: `example.com`. */
  readonly rpId: string
}) {
  const challenge = yield* newChallenge
  const options: AuthenticationOptions = {
    challenge,
    rpId: input.rpId,
    timeout: ceremonyMs,
    userVerification: "required",
    allowCredentials: [],
  }
  return options
})

/**
 * What `navigator.credentials.create()` returned, as its `toJSON()` gives it, or an app sends it:
 * the fields this package reads. Others, such as `publicKey`, are ignored: the key is read from the
 * authenticator data, which the device made.
 */
export const RegistrationResponse = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.String,
  }).annotate({ identifier: "PasskeyAttestation" }),
}).annotate({ identifier: "PasskeyRegistration" })
export type RegistrationResponse = typeof RegistrationResponse.Type

/** What `navigator.credentials.get()` returned, as its `toJSON()` gives it, or an app sends it. */
export const AuthenticationResponse = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  response: Schema.Struct({
    clientDataJSON: Schema.String,
    authenticatorData: Schema.String,
    signature: Schema.String,
    /** The account's user handle, which a discoverable passkey returns; required to sign in. */
    userHandle: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }).annotate({ identifier: "PasskeyAssertion" }),
}).annotate({ identifier: "PasskeyAuthentication" })
export type AuthenticationResponse = typeof AuthenticationResponse.Type

/** What a ceremony must match: the challenge kept for it, where it ran, and the site. */
export interface Expected {
  /** The challenge the caller kept for this ceremony, never the one the answer names. */
  readonly challenge: string
  /**
   * The origins a ceremony may run on: `https://example.com`, as the page or the app that ran it
   * is served (an iPhone app's passkeys run on `https://` its associated domain).
   */
  readonly origins: ReadonlyArray<string>
  /** The site's hostname: `example.com`. */
  readonly rpId: string
}

/** What a registration must match: as `Expected`, and the account it makes a passkey for. */
export interface RegistrationExpected extends Expected {
  /** The account's user handle, the `user.id` its options gave. */
  readonly userHandle: string
}

/**
 * A registered passkey: its ID, its public key as SPKI, both base64url, its signature counter, and
 * the account it belongs to. Keep each ID once: refuse a registration whose ID is already kept, for
 * this account or another.
 */
export interface Passkey {
  readonly id: string
  readonly publicKey: string
  readonly signCount: number
  readonly userHandle: string
}

/** The passkey's answer doesn't hold: `reason` says what, for logs; tell the person only to try again. */
export class WebAuthnRejected extends Schema.TaggedError<WebAuthnRejected>()("WebAuthnRejected", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The passkey's answer was refused: ${this.reason}`
  }
}

const AnswerWithClientData = Schema.Struct({ response: Schema.Struct({ clientDataJSON: Schema.String }) })

/**
 * The challenge an answer, a registration or an authentication, names, unchecked: the client chose
 * it. Use it only to find and take the challenge kept for it, bound to its purpose and, for a
 * registration, to its account; then pass the kept one as `Expected.challenge`, never this.
 */
export const challengeOf = Effect.fn("challengeOf")(function* (answer: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(AnswerWithClientData)(answer).pipe(
    Effect.mapError(() => new WebAuthnRejected({ reason: "The answer isn't WebAuthn's JSON" })),
  )
  const clientData = yield* clientDataOf(decoded.response.clientDataJSON)
  return clientData.decoded.challenge
})

/**
 * Checks a new passkey: its client data is a creation for `expected`'s challenge on one of its
 * origins; its authenticator data is for `expected`'s site, with the person present and verified,
 * and holds a credential whose ID is the answer's and whose key is ES256 on P-256. The passkey to
 * keep, for `expected.userHandle`'s account, with its counter. Attestation isn't checked: any
 * authenticator may register. An answer that isn't WebAuthn's JSON is refused, not a defect.
 */
export const verifyRegistration = Effect.fn("verifyRegistration")(function* (
  crypto: WebAuthnCrypto,
  answer: unknown,
  expected: RegistrationExpected,
) {
  const registration = yield* Schema.decodeUnknownEffect(RegistrationResponse)(answer).pipe(
    Effect.mapError(() => new WebAuthnRejected({ reason: "The answer isn't a WebAuthn registration's JSON" })),
  )
  if (registration.type !== "public-key") {
    return yield* new WebAuthnRejected({ reason: "The credential isn't a public-key credential" })
  }
  if (!isUserHandle(expected.userHandle)) {
    return yield* new WebAuthnRejected({
      reason: "The account's user handle isn't 1 to 64 bytes of canonical base64url",
    })
  }
  yield* checkClientData(registration.response.clientDataJSON, "webauthn.create", expected)
  const data = yield* bytesOf(registration.response.authenticatorData, "authenticator data")
  const authenticator = yield* checkAuthenticatorData(crypto, data, expected.rpId)
  if ((authenticator.flags & attestedData) === 0 || data.length < 55) {
    return yield* new WebAuthnRejected({ reason: "The authenticator data has no credential" })
  }
  const idLength = ((data[53] ?? 0) << 8) | (data[54] ?? 0)
  if (idLength < 16 || idLength > 1023 || data.length < 55 + idLength) {
    return yield* new WebAuthnRejected({
      reason: "The credential's ID is out of bounds: 16 to 1023 bytes, within the data",
    })
  }
  if (Base64Url.encode(data.subarray(55, 55 + idLength)) !== registration.id) {
    return yield* new WebAuthnRejected({ reason: "The credential's ID isn't the one its data names" })
  }
  const key = publicKeyOf(data.subarray(55 + idLength))
  if (key === undefined) {
    return yield* new WebAuthnRejected({
      reason: "The passkey's key isn't ES256 on P-256, in the form devices write it",
    })
  }
  const extensions = (authenticator.flags & extensionData) !== 0
  if (key.length < data.length - 55 - idLength && !extensions) {
    return yield* new WebAuthnRejected({ reason: "The authenticator data has bytes after the key" })
  }
  yield* importKey(crypto, key.spki)
  const passkey: Passkey = {
    id: registration.id,
    publicKey: Base64Url.encode(key.spki),
    signCount: authenticator.signCount,
    userHandle: expected.userHandle,
  }
  return passkey
})

/**
 * Checks a sign-in with `passkey`: the answer is `passkey`'s and names its account; its client data
 * is a request for `expected`'s challenge on one of its origins; its authenticator data is for
 * `expected`'s site with the person present and verified; its signature is the passkey's; and its
 * counter moved on, unless the authenticator keeps none. Look the passkey up by the answer's `id`
 * alone. The counter to keep. An answer that isn't WebAuthn's JSON is refused, not a defect.
 */
export const verifyAuthentication = Effect.fn("verifyAuthentication")(function* (
  crypto: WebAuthnCrypto,
  answer: unknown,
  passkey: Passkey,
  expected: Expected,
) {
  const authentication = yield* Schema.decodeUnknownEffect(AuthenticationResponse)(answer).pipe(
    Effect.mapError(() => new WebAuthnRejected({ reason: "The answer isn't a WebAuthn authentication's JSON" })),
  )
  if (authentication.type !== "public-key") {
    return yield* new WebAuthnRejected({ reason: "The credential isn't a public-key credential" })
  }
  if (authentication.id !== passkey.id) {
    return yield* new WebAuthnRejected({ reason: "The answer is another passkey's" })
  }
  // The user handle isn't signed: an answer could name any account, so it must name the passkey's
  // (WebAuthn, section 7.2, step 6).
  if (authentication.response.userHandle !== passkey.userHandle) {
    return yield* new WebAuthnRejected({ reason: "The answer doesn't name the passkey's account" })
  }
  const clientData = yield* checkClientData(authentication.response.clientDataJSON, "webauthn.get", expected)
  const data = yield* bytesOf(authentication.response.authenticatorData, "authenticator data")
  const authenticator = yield* checkAuthenticatorData(crypto, data, expected.rpId)
  // A sign-in's authenticator data is 37 bytes, then extensions only if it says so; never a credential.
  const extensions = (authenticator.flags & extensionData) !== 0
  const shaped = (authenticator.flags & attestedData) === 0 && (extensions ? data.length > 37 : data.length === 37)
  if (!shaped) {
    return yield* new WebAuthnRejected({ reason: "The authenticator data isn't a sign-in's" })
  }
  const der = yield* bytesOf(authentication.response.signature, "signature")
  const signature = rawSignatureOf(der)
  if (signature === undefined) {
    return yield* new WebAuthnRejected({ reason: "The signature isn't ECDSA in DER" })
  }
  const key = yield* importKey(crypto, yield* bytesOf(passkey.publicKey, "public key"))
  const clientDataHash = new Uint8Array(yield* Effect.promise(() => crypto.digest("SHA-256", clientData)))
  const signed = new Uint8Array(data.length + clientDataHash.length)
  signed.set(data)
  signed.set(clientDataHash, data.length)
  const valid = yield* Effect.tryPromise({
    try: () => crypto.verify({ name: "ECDSA", hash: "SHA-256" }, key, signature, signed),
    catch: () => new WebAuthnRejected({ reason: "The signature couldn't be checked" }),
  })
  if (!valid) {
    return yield* new WebAuthnRejected({ reason: "The signature isn't the passkey's" })
  }
  // A counter that doesn't move on means a copy of the key signed: unless it never counts, as
  // synced passkeys don't, which keep 0.
  if (passkey.signCount !== 0 && authenticator.signCount <= passkey.signCount) {
    return yield* new WebAuthnRejected({ reason: "The signature counter went back" })
  }
  return { signCount: authenticator.signCount }
})

const es256 = -7
const ceremonyMs = 300_000

// The authenticator data's flags (WebAuthn, section 6.1).
const userPresent = 0x01
const userVerified = 0x04
const backupEligible = 0x08
const backedUp = 0x10
const attestedData = 0x40
const extensionData = 0x80

// 32 random bytes, base64url: WebAuthn asks for at least 16. A platform that can't give random
// bytes is one no caller can fix, so it dies.
const newChallenge = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie)
  return Base64Url.encode(bytes)
})

// Whether `id` is a user handle: base64url of 1 to 64 bytes (WebAuthn, section 5.4.3).
// A device sends the handle back canonical, so one written otherwise would never match it.
const isUserHandle = (id: string) => {
  const bytes = Base64Url.decode(id)
  return (
    Result.isSuccess(bytes) &&
    bytes.success.length >= 1 &&
    bytes.success.length <= 64 &&
    Base64Url.encode(bytes.success) === id
  )
}

// A challenge this package made is 32 bytes; one under 16 is a caller's mistake, such as a
// challenge that wasn't found, and nothing may match it.
const isChallenge = (challenge: string) => {
  const bytes = Base64Url.decode(challenge)
  return Result.isSuccess(bytes) && bytes.success.length >= 16
}

const ClientData = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    challenge: Schema.String,
    origin: Schema.String,
    crossOrigin: Schema.optionalKey(Schema.Boolean),
    topOrigin: Schema.optionalKey(Schema.String),
  }),
)

// Text an answer chose, as a reason shows it: quoted, printable ASCII only, without quotes or
// backslashes of its own, and short, so it can't forge or flood a log line.
const shown = (text: string) => {
  const printable = text.replace(/[^\x20\x21\x23-\x5b\x5d-\x7e]/g, "?")
  const short = printable.length > 80 ? `${printable.slice(0, 80)}…` : printable
  return `"${short}"`
}

// The bytes of base64url text, in a buffer of their own, as Web Crypto takes them. Only the one
// canonical text of some bytes is read (RFC 4648, section 3.5: no padding, no line breaks, no
// spare bits), so one answer has one text.
const bytesOf = (base64url: string, what: string): Effect.Effect<Uint8Array<ArrayBuffer>, WebAuthnRejected> => {
  const bytes = Base64Url.decode(base64url)
  return Result.isSuccess(bytes) && Base64Url.encode(bytes.success) === base64url
    ? Effect.succeed(new Uint8Array(bytes.success))
    : Effect.fail(new WebAuthnRejected({ reason: `The ${what} isn't canonical base64url` }))
}

// The client data's bytes and what they say, unchecked.
const clientDataOf = Effect.fnUntraced(function* (base64url: string) {
  const bytes = yield* bytesOf(base64url, "client data")
  const decoded = yield* Schema.decodeEffect(ClientData)(utf8.decode(bytes)).pipe(
    Effect.mapError(() => new WebAuthnRejected({ reason: "The client data isn't WebAuthn's JSON" })),
  )
  return { bytes, decoded }
})

// The client data's bytes, once its type, challenge and origin are the ones expected.
const checkClientData = Effect.fnUntraced(function* (base64url: string, type: string, expected: Expected) {
  if (!isChallenge(expected.challenge)) {
    return yield* new WebAuthnRejected({ reason: "The challenge kept for this ceremony isn't one: under 16 bytes" })
  }
  const { bytes, decoded } = yield* clientDataOf(base64url)
  if (decoded.type !== type) {
    return yield* new WebAuthnRejected({ reason: `The client data isn't a ${type}` })
  }
  if (decoded.challenge !== expected.challenge) {
    return yield* new WebAuthnRejected({ reason: "The challenge isn't the one kept" })
  }
  if (decoded.crossOrigin === true || decoded.topOrigin !== undefined) {
    return yield* new WebAuthnRejected({ reason: "The ceremony ran in a frame of another site" })
  }
  if (!expected.origins.includes(decoded.origin)) {
    return yield* new WebAuthnRejected({ reason: `The origin ${shown(decoded.origin)} isn't one of the site's` })
  }
  return bytes
})

// The authenticator data's flags and counter, once it is for the site, with the person present and
// verified, and its backup flags agree (WebAuthn, section 6.1: backed up only if eligible).
const checkAuthenticatorData = Effect.fnUntraced(function* (crypto: WebAuthnCrypto, data: Uint8Array, rpId: string) {
  if (data.length < 37) {
    return yield* new WebAuthnRejected({ reason: "The authenticator data is too short" })
  }
  const rpIdHash = new Uint8Array(yield* Effect.promise(() => crypto.digest("SHA-256", utf8.encode(rpId))))
  if (!rpIdHash.every((byte, index) => byte === data[index])) {
    return yield* new WebAuthnRejected({ reason: "The passkey isn't for this site" })
  }
  const flags = data[32] ?? 0
  if ((flags & userPresent) === 0 || (flags & userVerified) === 0) {
    return yield* new WebAuthnRejected({ reason: "The person wasn't verified" })
  }
  if ((flags & backedUp) !== 0 && (flags & backupEligible) === 0) {
    return yield* new WebAuthnRejected({ reason: "The authenticator data says backed up but not eligible" })
  }
  const signCount = (((data[33] ?? 0) << 24) >>> 0) + ((data[34] ?? 0) << 16) + ((data[35] ?? 0) << 8) + (data[36] ?? 0)
  return { flags, signCount }
})

const importKey = (crypto: WebAuthnCrypto, spki: Uint8Array<ArrayBuffer>) =>
  Effect.tryPromise({
    try: () => crypto.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    catch: () => new WebAuthnRejected({ reason: "The public key isn't a P-256 key" }),
  })

// Every runtime this package runs on has these; declared here, in this package's terms.
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }
declare const TextDecoder: new (label: "utf-8") => { readonly decode: (input: Uint8Array) => string }
const utf8 = {
  encode: (text: string) => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array) => new TextDecoder("utf-8").decode(bytes),
}
