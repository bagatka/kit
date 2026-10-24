import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Cause, Crypto, Effect, Exit, Layer, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"

import type { AuthenticatorCrypto, Ceremony, RegistrationExpected } from "../src/index.ts"
import {
  AuthenticationOptions,
  authenticationOptions,
  challengeOf,
  RegistrationOptions,
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
const ClientDataText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

// An answer with its authenticator data, its client data, or its other fields changed.
type Answer = { readonly id: string; readonly type: string; readonly response: Record<string, unknown> } & {
  readonly response: { readonly authenticatorData: string; readonly clientDataJSON: string }
}
const withData = <A extends Answer>(answer: A, change: (data: Uint8Array) => Uint8Array): A => ({
  ...answer,
  response: { ...answer.response, authenticatorData: changed(answer.response.authenticatorData, change) },
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
      const changedData = (change: (data: Uint8Array) => Uint8Array) => withData(registration, change)
      const reasons = [
        // Cut after the counter, though it says a credential follows.
        changedData((data) => data.subarray(0, 37)),
        // An ID length past the end of the data, and one under 16 bytes.
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 53 ? 0xff : byte))),
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 54 ? 8 : byte))),
        // A key whose algorithm is RS256 (-257) instead of ES256.
        changedData((data) => Uint8Array.from(data, (byte, index) => (index === 55 + 16 + 4 ? 0x39 : byte))),
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

  it.effect("reads only canonical base64url, and refuses a signature whose INTEGERs don't fit P-256", () =>
    Effect.gen(function* () {
      const authenticator = yield* newAuthenticator
      const passkey = yield* verifyRegistration(subtle, yield* authenticator.register(ceremony, account), expected)
      const signed = yield* authenticator.authenticate(ceremony)
      const padded = { ...signed, response: { ...signed.response, signature: `${signed.response.signature}=` } }
      // An INTEGER longer than P-256's 32 bytes doesn't fit, and is refused before Web Crypto sees it.
      const tooLong = changed(signed.response.signature, () =>
        Uint8Array.of(0x30, 0x46, 0x02, 0x21, 0x7f, ...new Uint8Array(32), 0x02, 0x21, 0x7f, ...new Uint8Array(32)),
      )
      const notDer = { ...signed, response: { ...signed.response, signature: tooLong } }
      assert.deepStrictEqual(
        [
          yield* reasonOf(verifyAuthentication(subtle, padded, passkey, expected)),
          yield* reasonOf(verifyAuthentication(subtle, notDer, passkey, expected)),
        ],
        ["The signature isn't canonical base64url", "The signature isn't ECDSA in DER"],
      )
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

  it.effect("takes its challenges from the Crypto service the caller provides", () =>
    Effect.gen(function* () {
      const options = yield* authenticationOptions({ rpId: "notes.example" })
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
        [withData(registration, (data) => data.subarray(0, 36)), expected, "The authenticator data is too short"],
        [
          withData(
            registration,
            withByte(0, (byte) => byte ^ 1),
          ),
          expected,
          "The passkey isn't for this site",
        ],
        [
          withData(
            registration,
            withByte(flagsAt, (byte) => byte & ~userPresent),
          ),
          expected,
          "The person wasn't verified",
        ],
        [
          withData(
            registration,
            withByte(flagsAt, (byte) => byte & ~attestedData),
          ),
          expected,
          "The authenticator data has no credential",
        ],
        [{ ...registration, id: other.id }, expected, "The credential's ID isn't the one its data names"],
        // An ID of 1,000 bytes, within its bounds, in data that ends long before it.
        [
          withData(registration, (data) => withByte(54, () => 0xe8)(withByte(53, () => 0x03)(data))),
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
      const withExtensions = withData(registration, (data) =>
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
      assert.deepStrictEqual(yield* Schema.decodeEffect(RegistrationOptions)(registration), registration)
      assert.deepStrictEqual(yield* Schema.decodeEffect(AuthenticationOptions)(authentication), authentication)
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  )
})
