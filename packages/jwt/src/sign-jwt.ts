import { Effect, Record, Schema } from "effect"
import { Base64Url } from "effect/encoding"

import { signWith } from "./signing-key.ts"
import type { SigningKey } from "./signing-key.ts"

const encodeJsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.JsonObject))

/**
 * A JWT signed with `key`, as a compact JWS: the header, the claims, and the signature, each
 * base64url. The header is `{"alg": <the key's algorithm>, ...header}`: an `alg` in `header` is
 * replaced by the key's, so a token never claims to be signed differently than it is. Claims are
 * JSON in the order given. ES256's signature is r‖s, 64 bytes, as JWS takes it (RFC 7518, section
 * 3.4). What the claims say, such as `iat` and `exp`, is the caller's. Signing never fails: the key
 * was checked when it was imported. A header with `crit` or `b64`, which change how a token is read
 * (RFC 7515, section 4.1.11; RFC 7797), a header or claims that aren't JSON (NaN, Infinity, a
 * cycle), or a key another copy of this package made, is a bug, and dies.
 */
export const signJwt = Effect.fn("signJwt")(function* (
  key: SigningKey,
  header: Schema.JsonObject,
  claims: Schema.JsonObject,
) {
  // Copied once, and only the copy is read: a header that changes as it is read, as a Proxy can,
  // can't show the checks one thing and the token another.
  const fields = Record.remove<string, Schema.Json, "alg">(Object.fromEntries(Object.entries(header)), "alg")
  const unsupported = ["crit", "b64"].filter((name) => Object.hasOwn(fields, name))
  if (unsupported.length > 0) {
    return yield* Effect.die(`signJwt doesn't support the header fields ${unsupported.join(" and ")}`)
  }
  const protectedHeader = { alg: key.algorithm, ...fields }
  const headerText = yield* encodeJsonText(protectedHeader).pipe(Effect.orDie)
  const claimsText = yield* encodeJsonText(claims).pipe(Effect.orDie)
  const unsigned = `${Base64Url.encode(headerText)}.${Base64Url.encode(claimsText)}`
  const signature = yield* signWith(key, asciiBytes(unsigned))
  return `${unsigned}.${Base64Url.encode(signature)}`
})

// The bytes of text that is ASCII, as a JWS's base64url parts are.
const asciiBytes = (text: string) => Uint8Array.from(text, (character) => character.charCodeAt(0))
