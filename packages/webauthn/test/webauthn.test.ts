import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Crypto, Effect, Exit, Layer, Result, Schema } from "effect"
import { Base64Url, Hex } from "effect/encoding"

import type { AuthenticatorCrypto, Ceremony, RegistrationExpected, RegistrationResponseJSON } from "../src/index.ts"
import {
  authenticationOptions,
  challengeOf,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  registrationOptions,
  softwareAuthenticator,
  verifyAuthentication,
  verifyRegistration,
} from "../src/index.ts"

// The runtime's Web Crypto, which tests outside a runtime with its types can't name.
declare const crypto: AuthenticatorCrypto
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }
const subtle = crypto.subtle
const newAuthenticator = softwareAuthenticator(crypto)

// Where the tests' passkeys are made and used: the site's page, for one account.
const ceremony: Ceremony = {
  challenge: "q3W8mYpZf1o7oG2bTnS0xR4kL9vC6aJ2eH5dU8iN1wE",
  origin: "https://notes.example",
  rpId: "notes.example",
}
const account = { userHandle: "dXNlci1oYW5kbGUtMDAx" }
const expected: RegistrationExpected = {
  challenge: ceremony.challenge,
  origins: ["https://notes.example", "https://www.notes.example"],
  rpId: "notes.example",
  userHandle: account.userHandle,
}

const reasonOf = <A, R>(effect: Effect.Effect<A, { readonly reason: string }, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((rejected) => rejected.reason),
  )

// Base64url's bytes, and back, for answers the tests change by hand.
const bytes = (base64url: string) =>
  new Uint8Array(Result.getOrElse(Base64Url.decode(base64url), () => new Uint8Array(0)))
const changed = (base64url: string, change: (data: Uint8Array) => Uint8Array) =>
  Base64Url.encode(change(bytes(base64url)))
// A DER signature with its r changed, its lengths made to match.
const withR = (change: (r: Uint8Array) => Uint8Array) => (data: Uint8Array) => {
  const rLength = data[3] ?? 0
  const r = change(data.subarray(4, 4 + rLength))
  const body = Uint8Array.of(0x02, r.length, ...r, ...data.subarray(4 + rLength))
  return Uint8Array.of(0x30, body.length, ...body)
}
const ClientDataText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

// An answer with its authenticator data, its client data, or its other fields changed.
type Answer = { readonly id: string; readonly type: string; readonly response: Record<string, unknown> } & {
  readonly response: { readonly authenticatorData: string; readonly clientDataJSON: string }
}
const withData = <A extends Answer>(answer: A, change: (data: Uint8Array) => Uint8Array): A => ({
  ...answer,
  response: { ...answer.response, authenticatorData: changed(answer.response.authenticatorData, change) },
})
// The authenticator data a registration's attestation object holds, which the software
// authenticator also sends beside it, as browsers do; and an attestation object of format `none`
// around changed data, written here as CBOR by hand (RFC 8949), apart from the package's own.
const attestedDataOf = (registration: RegistrationResponseJSON) => {
  const response: object = registration.response
  return "authenticatorData" in response && typeof response.authenticatorData === "string"
    ? bytes(response.authenticatorData)
    : new Uint8Array(0)
}
const ascii = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))
const noneAttestation = (data: Uint8Array) =>
  Uint8Array.of(
    0xa3,
    0x63,
    ...ascii("fmt"),
    0x64,
    ...ascii("none"),
    0x67,
    ...ascii("attStmt"),
    0xa0,
    0x68,
    ...ascii("authData"),
    0x59,
    data.length >> 8,
    data.length & 0xff,
    ...data,
  )
// A CBOR text string of a short name: an attestation object's key, or its format.
const key = (name: string) => [0x60 | name.length, ...ascii(name)]
const withAttestedData = (registration: RegistrationResponseJSON, change: (data: Uint8Array) => Uint8Array) => ({
  ...registration,
  response: {
    ...registration.response,
    attestationObject: Base64Url.encode(noneAttestation(change(attestedDataOf(registration)))),
  },
})
const withByte = (index: number, change: (byte: number) => number) => (data: Uint8Array) =>
  Uint8Array.from(data, (byte, at) => (at === index ? change(byte) : byte))
// The authenticator data's flags byte, and its bits (WebAuthn, section 6.1).
const flagsAt = 32
const userPresent = 0x01
const attestedData = 0x40
const extensionData = 0x80

describe("passkeys", () => {
  it.effect("registers a passkey made for the site, and signs in with it", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      assert.strictEqual(yield* challengeOf(registration), expected.challenge)
      const passkey = yield* verifyRegistration(subtle, registration, expected)
      assert.strictEqual(passkey.id, authenticator.id)
      assert.strictEqual(passkey.signCount, 0)
      assert.strictEqual(passkey.userHandle, account.userHandle)

      // Synced passkeys count nothing; one that counts must count on.
      const synced = yield* verifyAuthentication(subtle, yield* authenticator.authenticate(ceremony), passkey, expected)
      assert.strictEqual(synced.signCount, 0)
      const counted = yield* verifyAuthentication(
        subtle,
        yield* authenticator.authenticate(ceremony, { signCount: 7 }),
        { ...passkey, signCount: 6 },
        expected,
      )
      assert.strictEqual(counted.signCount, 7)
    }),
  )

  it.effect("refuses a passkey made for another challenge, page or site, or without the person verified", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const register = (change: Partial<Ceremony>, verified = true) =>
        authenticator.register({ ...ceremony, ...change }, { ...account, verified })

      assert.deepStrictEqual(
        [
          yield* reasonOf(verifyRegistration(subtle, yield* register({ challenge: "an-old-one" }), expected)),
          yield* reasonOf(verifyRegistration(subtle, yield* register({ origin: "https://evil.example" }), expected)),
          yield* reasonOf(verifyRegistration(subtle, yield* register({ rpId: "evil.example" }), expected)),
          yield* reasonOf(verifyRegistration(subtle, yield* register({}, false), expected)),
        ],
        [
          "The challenge isn't the one kept",
          `The origin "https://evil.example" isn't one of the site's`,
          "The passkey isn't for this site",
          "The person wasn't verified",
        ],
      )
    }),
  )

  it.effect("refuses a sign-in signed by another key, with its data changed, or with its counter gone back", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const other = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      yield* other.register(ceremony, account)

      const forged = yield* other.authenticate(ceremony)
      const signed = yield* authenticator.authenticate(ceremony, { signCount: 3 })
      const later = yield* authenticator.authenticate(ceremony, { signCount: 9 })
      const swapped = {
        ...signed,
        response: { ...signed.response, authenticatorData: later.response.authenticatorData },
      }
      assert.deepStrictEqual(
        [
          yield* reasonOf(verifyAuthentication(subtle, { ...forged, id: passkey.id }, passkey, expected)),
          yield* reasonOf(verifyAuthentication(subtle, swapped, passkey, expected)),
          yield* reasonOf(verifyAuthentication(subtle, signed, { ...passkey, signCount: 3 }, expected)),
          yield* reasonOf(
            verifyAuthentication(
              subtle,
              yield* authenticator.authenticate(ceremony, { type: "webauthn.create" }),
              passkey,
              expected,
            ),
          ),
          yield* reasonOf(verifyAuthentication(subtle, signed, { ...passkey, id: other.id }, expected)),
        ],
        [
          "The signature isn't the passkey's",
          "The signature isn't the passkey's",
          "The signature counter went back",
          "The client data isn't a webauthn.get",
          "The answer is another passkey's",
        ],
      )
    }),
  )

  it.effect("refuses a sign-in that names another account, or none: the user handle isn't signed", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const signed = yield* authenticator.authenticate(ceremony)
      const answers = [
        { ...signed, response: { ...signed.response, userHandle: "dmljdGltLWhhbmRsZQ" } },
        { ...signed, response: { ...signed.response, userHandle: null } },
      ]
      for (const answer of answers) {
        assert.strictEqual(
          yield* reasonOf(verifyAuthentication(subtle, answer, passkey, expected)),
          "The answer doesn't name the passkey's account",
        )
      }
    }),
  )

  it.effect("refuses every ceremony when the challenge kept for it isn't one, such as one not found", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      for (const kept of ["", "c2hvcnQ"]) {
        const registration = yield* authenticator.register({ ...ceremony, challenge: kept }, account)
        assert.strictEqual(
          yield* reasonOf(verifyRegistration(subtle, registration, { ...expected, challenge: kept })),
          "The challenge kept for this ceremony isn't one: under 16 bytes",
        )
      }
    }),
  )

  it.effect("reads the key from the authenticator data, and refuses data that isn't a credential's", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const changedData = (change: (data: Uint8Array) => Uint8Array) => withAttestedData(registration, change)
      const reasons = [
        // Cut after the counter, though it says a credential follows.
        changedData((data) => data.subarray(0, 37)),
        // An ID length past the end of the data, and one under 16 bytes.
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 53 ? 0xff : byte))),
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 54 ? 8 : byte))),
        // A key whose algorithm is RS256 (-257) instead of ES256.
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 55 + 16 + 4 ? 0x39 : byte))),
        // A key cut short by its last byte.
        changedData((data) => data.subarray(0, data.length - 1)),
        // Bytes after the key, without the flag that says extensions follow.
        changedData((data) => Uint8Array.of(...data, 0xa0)),
        // Backed up, but not eligible for backup.
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 32 ? (byte | 0x10) & ~0x08 : byte))),
      ]
      assert.deepStrictEqual(
        yield* Effect.forEach(reasons, (answer) => reasonOf(verifyRegistration(subtle, answer, expected))),
        [
          "The authenticator data has no credential",
          "The credential's ID is out of bounds: 16 to 1023 bytes, within the data",
          "The credential's ID is out of bounds: 16 to 1023 bytes, within the data",
          "The passkey's key isn't ES256 on P-256, in the form devices write it",
          "The passkey's key isn't ES256 on P-256, in the form devices write it",
          "The authenticator data has bytes after the key",
          "The authenticator data says backed up but not eligible",
        ],
      )
    }),
  )

  it.effect("refuses a sign-in whose data claims a credential or extensions it doesn't have", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const signed = yield* authenticator.authenticate(ceremony)
      const withFlags = (flags: number) => ({
        ...signed,
        response: {
          ...signed.response,
          authenticatorData: changed(signed.response.authenticatorData, (data) =>
            Uint8Array.from(data, (byte, index) => (index === 32 ? byte | flags : byte)),
          ),
        },
      })
      for (const flags of [0x40, 0x80]) {
        assert.strictEqual(
          yield* reasonOf(verifyAuthentication(subtle, withFlags(flags), passkey, expected)),
          "The authenticator data isn't a sign-in's",
        )
      }
    }),
  )

  it.effect("reads only canonical base64url, and only strict DER, whose INTEGERs fit P-256", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      // A signature whose r needs no leading zero, as half of them do, so adding one is refused only
      // as a zero it doesn't need.
      let signed = yield* authenticator.authenticate(ceremony)
      while (bytes(signed.response.signature)[4] === 0) {
        signed = yield* authenticator.authenticate(ceremony)
      }
      const padded = { ...signed, response: { ...signed.response, signature: `${signed.response.signature}=` } }
      // An INTEGER longer than P-256's 32 bytes doesn't fit, and is refused before Web Crypto sees it.
      const tooLong = changed(signed.response.signature, () =>
        Uint8Array.of(0x30, 0x46, 0x02, 0x21, 0x7f, ...new Uint8Array(32), 0x02, 0x21, 0x7f, ...new Uint8Array(32)),
      )
      // The same r and s in another encoding, which Web Crypto, seeing only r and s, would take: a
      // wrong tag or length, bytes after the SEQUENCE, and r with a zero it doesn't need, or negative.
      // A zero r doesn't need, r with no bytes, and r made negative: its zero removed, or its first byte high.
      const extraZero = withR((r) => Uint8Array.of(0, ...r))
      const empty = withR(() => new Uint8Array(0))
      const negative = withR((r) =>
        r[0] === 0 ? r.subarray(1) : Uint8Array.from(r, (byte, index) => (index === 0 ? byte | 0x80 : byte)),
      )
      const reencoded = [
        tooLong,
        changed(signed.response.signature, (data) =>
          Uint8Array.from(data, (byte, index) => (index === 0 ? 0x31 : byte)),
        ),
        changed(signed.response.signature, (data) => Uint8Array.from(data, (byte, index) => (index === 1 ? 0 : byte))),
        changed(signed.response.signature, (data) =>
          Uint8Array.from(data, (byte, index) => (index === 2 ? 0x04 : byte)),
        ),
        changed(signed.response.signature, (data) => Uint8Array.of(...data, 0)),
        changed(signed.response.signature, (data) => Uint8Array.of(0x30, (data[1] ?? 0) + 1, ...data.subarray(2), 0)),
        changed(signed.response.signature, extraZero),
        changed(signed.response.signature, empty),
        changed(signed.response.signature, negative),
      ]
      assert.strictEqual(
        yield* reasonOf(verifyAuthentication(subtle, padded, passkey, expected)),
        "The signature isn't canonical base64url",
      )
      for (const signature of reencoded) {
        const answer = { ...signed, response: { ...signed.response, signature } }
        assert.strictEqual(
          yield* reasonOf(verifyAuthentication(subtle, answer, passkey, expected)),
          "The signature isn't ECDSA in DER",
          signature,
        )
      }
      // The answer as signed still signs in.
      yield* verifyAuthentication(subtle, signed, passkey, expected)
    }),
  )

  it.effect("refuses what isn't WebAuthn's JSON, rather than failing as a bug", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const junk: ReadonlyArray<unknown> = [null, "text", { id: 1 }, { id: "x", type: "public-key", response: [] }]
      for (const answer of junk) {
        assert.strictEqual(
          yield* reasonOf(verifyRegistration(subtle, answer, expected)),
          "The answer isn't a WebAuthn registration's JSON",
        )
        assert.strictEqual(
          yield* reasonOf(verifyAuthentication(subtle, answer, passkey, expected)),
          "The answer isn't a WebAuthn authentication's JSON",
        )
        assert.strictEqual(yield* reasonOf(challengeOf(answer)), "The answer isn't WebAuthn's JSON")
      }
    }),
  )

  it.effect("refuses a ceremony run in another site's frame, and keeps what an answer chose out of logs", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const withClientData = (fields: Record<string, Schema.Json>) =>
        Effect.gen(function* () {
          const text = yield* Schema.encodeEffect(ClientDataText)({
            type: "webauthn.create",
            challenge: ceremony.challenge,
            origin: ceremony.origin,
            ...fields,
          })
          return {
            ...registration,
            response: { ...registration.response, clientDataJSON: Base64Url.encode(new TextEncoder().encode(text)) },
          }
        }).pipe(Effect.orDie)
      assert.deepStrictEqual(
        [
          yield* reasonOf(verifyRegistration(subtle, yield* withClientData({ crossOrigin: true }), expected)),
          yield* reasonOf(
            verifyRegistration(subtle, yield* withClientData({ topOrigin: "https://evil.example" }), expected),
          ),
          yield* reasonOf(
            verifyRegistration(
              subtle,
              yield* withClientData({ origin: "https://x.example\n[ERROR] forged" }),
              expected,
            ),
          ),
          yield* reasonOf(
            verifyRegistration(subtle, yield* withClientData({ origin: 'x" result=accepted user="admin' }), expected),
          ),
          yield* reasonOf(
            verifyRegistration(
              subtle,
              yield* withClientData({ origin: `https://${"a".repeat(100)}.example` }),
              expected,
            ),
          ),
        ],
        [
          "The ceremony ran in a frame of another site",
          "The ceremony ran in a frame of another site",
          `The origin "https://x.example?[ERROR] forged" isn't one of the site's`,
          `The origin "x? result=accepted user=?admin" isn't one of the site's`,
          `The origin "https://${"a".repeat(72)}…" isn't one of the site's`,
        ],
      )
    }),
  )

  it.effect("accepts a passkey made on any of the site's origins", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const fromWww = { ...ceremony, origin: "https://www.notes.example" }
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(fromWww, account), expected)
      const signedIn = yield* verifyAuthentication(
        subtle,
        yield* authenticator.authenticate(ceremony),
        passkey,
        expected,
      )
      assert.strictEqual(signedIn.signCount, 0)
    }),
  )

  it.effect("asks browsers for a discoverable ES256 passkey the person verifies, with a new challenge each time", () =>
    Effect.gen(function* () {
      const input = {
        rp: { id: "notes.example", name: "Notes" },
        user: { id: account.userHandle, name: "ada@example.com", displayName: "Ada" },
        excludeIds: ["c29tZS1rZXk"],
      }
      const options = yield* registrationOptions(input)
      assert.deepStrictEqual(options.pubKeyCredParams, [{ type: "public-key", alg: -7 }])
      assert.deepStrictEqual(options.authenticatorSelection, {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      })
      assert.strictEqual(options.attestation, "none")
      assert.deepStrictEqual(options.excludeCredentials, [{ type: "public-key", id: "c29tZS1rZXk" }])
      // 32 random bytes, base64url without padding.
      assert.match(options.challenge, /^[A-Za-z0-9_-]{43}$/)
      const again = yield* registrationOptions(input)
      assert.notStrictEqual(again.challenge, options.challenge)

      const signIn = yield* authenticationOptions({ rpId: "notes.example" })
      assert.deepStrictEqual(signIn.allowCredentials, [])
      assert.strictEqual(signIn.userVerification, "required")
      assert.match(signIn.challenge, /^[A-Za-z0-9_-]{43}$/)

      // An email as the user handle is a bug, devices keep it and send it back; and so is a handle
      // that isn't canonical base64url, which a device would send back canonical and never match.
      for (const id of ["ada@example.com", "YR", "YQ=="]) {
        const exit = yield* registrationOptions({ ...input, user: { ...input.user, id } }).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  )

  it.effect("takes its challenges from the Crypto service the caller provides, and never fails", () =>
    Effect.gen(function* () {
      // A platform without random bytes is a defect, never a failure a caller must handle.
      const making: Effect.Effect<PublicKeyCredentialRequestOptionsJSON, never, Crypto.Crypto> = authenticationOptions({
        rpId: "notes.example",
      })
      const options = yield* making
      assert.strictEqual(options.challenge, Base64Url.encode(new Uint8Array(32).fill(7)))
    }).pipe(
      Effect.provide(
        Layer.succeed(
          Crypto.Crypto,
          Crypto.make({ randomBytes: (size) => new Uint8Array(size).fill(7), digest: () => Effect.die("unused") }),
        ),
      ),
    ),
  )

  it.effect("refuses a registration whose data isn't for the site, the person, or the credential it names", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const other = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const notJson = { ...registration, response: { ...registration.response, clientDataJSON: "bm90IGpzb24" } }
      const cases: ReadonlyArray<readonly [unknown, RegistrationExpected, string]> = [
        [{ ...registration, type: "password" }, expected, "The credential isn't a public-key credential"],
        [notJson, expected, "The client data isn't WebAuthn's JSON"],
        [
          withAttestedData(registration, (data) => data.subarray(0, 36)),
          expected,
          "The authenticator data is too short",
        ],
        [
          withAttestedData(
            registration,
            withByte(0, (byte) => byte ^ 1),
          ),
          expected,
          "The passkey isn't for this site",
        ],
        [
          withAttestedData(
            registration,
            withByte(flagsAt, (byte) => byte & ~userPresent),
          ),
          expected,
          "The person wasn't verified",
        ],
        [
          withAttestedData(
            registration,
            withByte(flagsAt, (byte) => byte & ~attestedData),
          ),
          expected,
          "The authenticator data has no credential",
        ],
        [{ ...registration, id: other.id }, expected, "The credential's ID isn't the one its data names"],
        // An ID of 1,000 bytes, within its bounds, in data that ends long before it.
        [
          withAttestedData(registration, (data) => withByte(54, () => 0xe8)(withByte(53, () => 0x03)(data))),
          expected,
          "The credential's ID is out of bounds: 16 to 1023 bytes, within the data",
        ],
        [
          registration,
          { ...expected, userHandle: Base64Url.encode(new Uint8Array(65)) },
          "The account's user handle isn't 1 to 64 bytes of canonical base64url",
        ],
      ]
      for (const [answer, ceremonyExpected, reason] of cases) {
        assert.strictEqual(yield* reasonOf(verifyRegistration(subtle, answer, ceremonyExpected)), reason)
      }
      // Bytes after the key are extensions when the data says so; a handle may be 64 bytes.
      const withExtensions = withAttestedData(registration, (data) =>
        Uint8Array.of(...withByte(flagsAt, (byte) => byte | extensionData)(data), 0xa0),
      )
      for (const handle of [Base64Url.encode(new Uint8Array(64).fill(7)), "AA"]) {
        const passkey = yield* verifyRegistration(subtle, withExtensions, { ...expected, userHandle: handle })
        assert.strictEqual(passkey.userHandle, handle)
      }
      const refused = yield* verifyRegistration(subtle, { ...registration, type: "password" }, expected).pipe(
        Effect.flip,
      )
      assert.strictEqual(
        refused.message,
        "The passkey's answer was refused: The credential isn't a public-key credential",
      )
    }),
  )

  it.effect("refuses a sign-in whose data isn't for the site or the person, or that can't be read", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const signed = yield* authenticator.authenticate(ceremony)
      const cases: ReadonlyArray<readonly [unknown, string]> = [
        [{ ...signed, type: "password" }, "The credential isn't a public-key credential"],
        [
          withData(
            signed,
            withByte(31, (byte) => byte ^ 1),
          ),
          "The passkey isn't for this site",
        ],
        [
          withData(
            signed,
            withByte(flagsAt, (byte) => byte & ~userPresent),
          ),
          "The person wasn't verified",
        ],
        [withData(signed, (data) => Uint8Array.of(...data, 0xa0)), "The authenticator data isn't a sign-in's"],
        [
          { ...signed, response: { ...signed.response, signature: "not base64url!" } },
          "The signature isn't canonical base64url",
        ],
      ]
      for (const [answer, reason] of cases) {
        assert.strictEqual(yield* reasonOf(verifyAuthentication(subtle, answer, passkey, expected)), reason)
      }
    }),
  )

  it.effect("reads counters past 255, and refuses one that went back to zero", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const counted = yield* verifyAuthentication(
        subtle,
        yield* authenticator.authenticate(ceremony, { signCount: 70_000 }),
        { ...passkey, signCount: 69_999 },
        expected,
      )
      assert.strictEqual(counted.signCount, 70_000)
      assert.strictEqual(
        yield* reasonOf(
          verifyAuthentication(
            subtle,
            yield* authenticator.authenticate(ceremony),
            { ...passkey, signCount: 5 },
            expected,
          ),
        ),
        "The signature counter went back",
      )
    }),
  )

  it.effect("makes options that decode through their own schemas, as an API that serves them does", () =>
    Effect.gen(function* () {
      const registration = yield* registrationOptions({
        rp: { id: "notes.example", name: "Notes" },
        user: { id: account.userHandle, name: "ada@example.com", displayName: "Ada" },
        excludeIds: ["c29tZS1rZXk"],
      })
      const authentication = yield* authenticationOptions({ rpId: "notes.example" })
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(PublicKeyCredentialCreationOptionsJSON)(registration),
        registration,
      )
      assert.deepStrictEqual(
        yield* Schema.decodeEffect(PublicKeyCredentialRequestOptionsJSON)(authentication),
        authentication,
      )
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  )
})

// WebAuthn Level 3's test vectors (section 16, https://www.w3.org/TR/webauthn-3/), for
// `example.org`: 16.7, an ES256 passkey with packed attestation, whose statement isn't checked;
// and 16.2's registration, without attestation, whose person wasn't verified.
const fromHex = (hex: string) => Base64Url.encode(Result.getOrElse(Hex.decode(hex), () => new Uint8Array(0)))
const packed = {
  registration: {
    id: fromHex("c9a6f5b3462d02873fea0c56862234f99f081728084e511bb7760201a89054a5"),
    type: "public-key",
    response: {
      clientDataJSON: fromHex(
        [
          "7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a227752684b5839333442",
          "4634543345663153324831706c61325a725751475046746877365356756d56494249222c226f726967696e223a226874",
          "7470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c226578747261446174",
          "61223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e",
          "616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20396138624e596a4b43",
          "6757724258552d66436c316167227d",
        ].join(""),
      ),
      attestationObject: fromHex(
        [
          "a363666d74667061636b65646761747453746d74a363616c6726637369675847304502203f19ec4b229f46ab8c45eff2",
          "9b904ff10c0390dc40bf1216f04a78f4ceba3425022100fe7041a32759aff05a0f9f26c70a999c7a284451ba89234a1d",
          "3483c25e21925b637835638159022530820221308201c8a00302010202110088c220f83c8ef1feafe94deae45faad030",
          "0a06082a8648ce3d0403023062311e301c06035504030c15576562417574686e207465737420766563746f7273310c30",
          "0a060355040a0c0357334331253023060355040b0c1c41757468656e74696361746f72204174746573746174696f6e20",
          "4341310b30090603550406130241413020170d3234303130313030303030305a180f3330323430313031303030303030",
          "5a305f311e301c06035504030c15576562417574686e207465737420766563746f7273310c300a060355040a0c035733",
          "4331223020060355040b0c1941757468656e74696361746f72204174746573746174696f6e310b300906035504061302",
          "41413059301306072a8648ce3d020106082a8648ce3d03010703420004a91ba4389409dd38a428141940ca8feb1ac0d7",
          "b4350558104a3777a49322f3798440f378b3398ab2d3bb7bf91322c92eb23556f59ad0a836fec4c7663b0e4dc3a36030",
          "5e300c0603551d130101ff04023000300e0603551d0f0101ff040403020780301d0603551d0e04160414a589ba72d060",
          "842ab11f74fb246bdedab16f9b9b301f0603551d2304183016801445aff715b0dd786741fee996ebc16547a3931b1e30",
          "0a06082a8648ce3d040302034700304402201726b9d85ecd8a5ed51163722ca3a20886fd9b242a0aa0453d442116075d",
          "efd502207ef471e530ac87961a88a7f0d0c17b091ffc6b9238d30f79f635b417be5910e768617574684461746158a4bf",
          "abc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b54d00000000876ca4f52071c3e9b25509ef",
          "2cdf7ed60020c9a6f5b3462d02873fea0c56862234f99f081728084e511bb7760201a89054a5a5010203262001215820",
          "1cf27f25da591208a4239c2e324f104f585525479a29edeedd830f48e77aeae522582059e4b7da6c0106e206ce390c93",
          "ab98a15a5ec3887e57f0cc2bece803b920c423",
        ].join(""),
      ),
    },
  },
  registrationChallenge: fromHex("c1184a5fddf8045e13dc47f54b61f5a656b666b59018f16d870e9256e9952012"),
  authentication: {
    id: fromHex("c9a6f5b3462d02873fea0c56862234f99f081728084e511bb7760201a89054a5"),
    type: "public-key",
    response: {
      clientDataJSON: fromHex(
        [
          "7b2274797065223a22776562617574686e2e676574222c226368616c6c656e6765223a22735242767047705876764634",
          "46524841565833496d4b4130453958773858306b526a44426c4d6668726255222c226f726967696e223a226874747073",
          "3a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c22657874726144617461223a",
          "22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e616c20",
          "6669656c647320696e20746865206675747572652c207375636820617320746869733a20415a4d77794d78496244382d",
          "756775464e7036723851227d",
        ].join(""),
      ),
      authenticatorData: fromHex("bfabc37432958b063360d3ad6461c9c4735ae7f8edd46592a5e0f01452b2e4b50d00000000"),
      signature: fromHex(
        [
          "30450220694969d3ee928de6f02ef23a9c644d7d779916451734a94b432542f498a1ebe90221008b0819c824218a9715",
          "2cd099c55bfb1477b29d900a49a64018314f9bfccda163",
        ].join(""),
      ),
      // The vectors' passkey names no account; this one names the account it was registered for.
      userHandle: "dXNlcg",
    },
  },
  authenticationChallenge: fromHex("b1106fa46a57bef1781511c0557dc898a03413d5f0f17d244630c194c7e1adb5"),
}
const unverified = {
  id: fromHex("f91f391db4c9b2fde0ea70189cba3fb63f579ba6122b33ad94ff3ec330084be4"),
  type: "public-key",
  response: {
    clientDataJSON: fromHex(
      [
        "7b2274797065223a22776562617574686e2e637265617465222c226368616c6c656e6765223a22414d4d507434557878",
        "475453746e63647134313759447742466938767049612d7077386f4f755657345441222c226f726967696e223a226874",
        "7470733a2f2f6578616d706c652e6f7267222c2263726f73734f726967696e223a66616c73652c226578747261446174",
        "61223a22636c69656e74446174614a534f4e206d617920626520657874656e6465642077697468206164646974696f6e",
        "616c206669656c647320696e20746865206675747572652c207375636820617320746869733a20426b5165446a646354",
        "427258426941774a544c453551227d",
      ].join(""),
    ),
    attestationObject: fromHex(
      [
        "a363666d74646e6f6e656761747453746d74a068617574684461746158a4bfabc37432958b063360d3ad6461c9c4735a",
        "e7f8edd46592a5e0f01452b2e4b559000000008446ccb9ab1db374750b2367ff6f3a1f0020f91f391db4c9b2fde0ea70",
        "189cba3fb63f579ba6122b33ad94ff3ec330084be4a5010203262001215820afefa16f97ca9b2d23eb86ccb64098d20d",
        "b90856062eb249c33a9b672f26df61225820930a56b87a2fca66334b03458abf879717c12cc68ed73290af2e2664796b",
        "9220",
      ].join(""),
    ),
  },
}
const vectorSite = { origins: ["https://example.org"], rpId: "example.org" }

describe("WebAuthn's test vectors", () => {
  it.effect("registers a passkey with packed attestation, skipping its statement, and signs in with it", () =>
    Effect.gen(function* () {
      const passkey = yield* verifyRegistration(subtle, packed.registration, {
        ...vectorSite,
        challenge: packed.registrationChallenge,
        userHandle: "dXNlcg",
      })
      assert.strictEqual(passkey.id, packed.registration.id)
      const signedIn = yield* verifyAuthentication(subtle, packed.authentication, passkey, {
        ...vectorSite,
        challenge: packed.authenticationChallenge,
      })
      assert.strictEqual(signedIn.signCount, 0)
    }),
  )

  it.effect("reads a registration without attestation, and refuses it: the person wasn't verified", () =>
    Effect.gen(function* () {
      const challenge = fromHex("00c30fb78531c464d2b6771dab8d7b603c01162f2fa486bea70f283ae556e130")
      assert.strictEqual(
        yield* reasonOf(verifyRegistration(subtle, unverified, { ...vectorSite, challenge, userHandle: "dXNlcg" })),
        "The person wasn't verified",
      )
    }),
  )
})

describe("attestation objects", () => {
  it.effect("reads the key from the attestation object, never from the fields a client sends beside it", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const other = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const otherRegistration = yield* other.register(ceremony, account)
      const { response: otherFields } = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ response: Schema.Struct({ authenticatorData: Schema.String, publicKey: Schema.String }) }),
      )(otherRegistration)
      const kept = yield* verifyRegistration(subtle, registration, expected)
      const passkey = yield* verifyRegistration(
        subtle,
        { ...registration, response: { ...registration.response, ...otherFields } },
        expected,
      )
      assert.strictEqual(passkey.publicKey, kept.publicKey)
      assert.notStrictEqual(passkey.publicKey, otherFields.publicKey)
    }),
  )

  it.effect("refuses one that isn't fmt, attStmt and authData in CBOR as WebAuthn writes it", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const data = attestedDataOf(registration)
      const fmt = [...key("fmt"), ...key("none")]
      const authData = (length: number) => [...key("authData"), 0x59, length >> 8, length & 0xff, ...data]
      const statement = (...value: ReadonlyArray<number>) => [...key("attStmt"), 0xa1, ...key("x"), ...value]
      const object = (...entries: ReadonlyArray<number>) => ({
        ...registration,
        response: { ...registration.response, attestationObject: Base64Url.encode(Uint8Array.from(entries)) },
      })
      const refused = [
        // A map of indefinite length, which authenticators never write.
        object(0xbf, ...fmt, ...statement(0), ...authData(data.length), 0xff),
        // A fourth entry; and `fmt` twice, without a statement.
        object(0xa4, ...fmt, ...statement(0), ...authData(data.length), ...key("x"), 0),
        object(0xa3, ...fmt, ...fmt, ...authData(data.length)),
        // Data longer than the bytes left, and a byte after the map.
        object(0xa3, ...fmt, ...statement(0), ...authData(data.length + 1)),
        object(0xa3, ...fmt, ...statement(0), ...authData(data.length), 0),
        // A format that isn't text.
        object(0xa3, ...key("fmt"), 1, ...statement(0), ...authData(data.length)),
        // A statement whose deepest item is 9 levels in, past the limit of 8; the object is level 0.
        object(0xa3, ...fmt, ...statement(...new Uint8Array(7).fill(0x81), 0), ...authData(data.length)),
        // An array that claims 2^64 - 1 items; and a reserved length (28), with the 16 bytes it would take.
        object(0xa3, ...fmt, ...statement(0x9b, ...new Uint8Array(8).fill(0xff)), ...authData(data.length)),
        object(0xa3, ...fmt, ...statement(0x1c, ...new Uint8Array(16).fill(0)), ...authData(data.length)),
      ]
      for (const answer of refused) {
        assert.strictEqual(
          yield* reasonOf(verifyRegistration(subtle, answer, expected)),
          "The attestation object isn't CBOR of fmt, attStmt and authData, as WebAuthn writes it",
        )
      }
      // In any order, with a statement whose deepest item is 8 levels in.
      const reordered = object(0xa3, ...authData(data.length), ...statement(...new Uint8Array(6).fill(0x81), 0), ...fmt)
      assert.strictEqual((yield* verifyRegistration(subtle, reordered, expected)).id, authenticator.id)
      assert.strictEqual(
        yield* reasonOf(
          verifyRegistration(
            subtle,
            { ...registration, response: { ...registration.response, attestationObject: "o2Nm=" } },
            expected,
          ),
        ),
        "The attestation object isn't canonical base64url",
      )
    }),
  )

  it.effect("reads a statement of a million items in linear time, and a megabyte of nesting without overflow", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const registration = yield* authenticator.register(ceremony, account)
      const data = attestedDataOf(registration)
      const withStatement = (statement: Uint8Array) => {
        const head = Uint8Array.of(
          0xa3,
          0x63,
          ...ascii("fmt"),
          0x64,
          ...ascii("none"),
          0x67,
          ...ascii("attStmt"),
          0xa1,
          0x61,
          0x78,
        )
        const tail = Uint8Array.of(0x68, ...ascii("authData"), 0x59, data.length >> 8, data.length & 0xff, ...data)
        const all = new Uint8Array(head.length + statement.length + tail.length)
        all.set(head)
        all.set(statement, head.length)
        all.set(tail, head.length + statement.length)
        return { ...registration, response: { ...registration.response, attestationObject: Base64Url.encode(all) } }
      }
      const million = new Uint8Array(5 + 1_000_000)
      million.set([0x9a, 0x00, 0x0f, 0x42, 0x40])
      assert.strictEqual((yield* verifyRegistration(subtle, withStatement(million), expected)).id, authenticator.id)
      assert.strictEqual(
        yield* reasonOf(verifyRegistration(subtle, withStatement(new Uint8Array(1_000_000).fill(0x81)), expected)),
        "The attestation object isn't CBOR of fmt, attStmt and authData, as WebAuthn writes it",
      )
    }),
  )
})
