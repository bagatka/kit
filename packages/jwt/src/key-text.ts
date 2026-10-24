import { Result } from "effect"
import { Base64 } from "effect/encoding"

import type { JwtAlgorithm } from "./signing-key.ts"

// The longest text a key may be: an 8192-bit RSA key in PEM is under 7 KiB.
const maxKeyText = 64 * 1024

// What each algorithm's key may be labelled, between `-----BEGIN ` and `-----`.
const labels: Record<JwtAlgorithm, ReadonlyArray<string>> = {
  ES256: ["PRIVATE KEY"],
  RS256: ["PRIVATE KEY", "RSA PRIVATE KEY"],
}

const beginLine = /-----BEGIN ([A-Z0-9 ]{1,40})-----/g
const armorLine = /-----(?:BEGIN|END) [A-Z0-9 ]{1,40}-----/g

/** A key's DER bytes, and its form: PKCS #1 when its armor says `RSA PRIVATE KEY`, else PKCS #8. */
export interface KeyDer {
  readonly der: Uint8Array<ArrayBuffer>
  readonly form: "pkcs1" | "pkcs8"
}

/**
 * The DER bytes of the one private key in `text`, a PEM block or the base64 inside one, in a buffer
 * of their own, and its form; or why there are none, in a sentence that never holds the key. Line
 * breaks written as `\n`, as settings often hold a PEM, are line breaks; base64 without armor is
 * PKCS #8. What the bytes are is Web Crypto's to check, when they are imported.
 */
export const derOfKey = (text: string, algorithm: JwtAlgorithm): Result.Result<KeyDer, string> => {
  if (text.length > maxKeyText) {
    return Result.fail("The key's text is over 64 KiB, longer than any ES256 or RS256 key")
  }
  const unescaped = text.replaceAll("\\n", "\n")
  const labelsFound = Array.from(unescaped.matchAll(beginLine), (match) => match[1] ?? "")
  const [label] = labelsFound
  if (labelsFound.length > 1) {
    return Result.fail(`The text holds ${labelsFound.length} PEM blocks; give the one key alone`)
  }
  if (label?.includes("ENCRYPTED") === true || unescaped.includes("Proc-Type:")) {
    return Result.fail("The key is encrypted; decrypt it first, such as with openssl pkcs8 -topk8 -nocrypt")
  }
  if (label !== undefined && !labels[algorithm].includes(label)) {
    return Result.fail(`The PEM block is labelled ${label}, not a private key ${algorithm} can sign with`)
  }
  const decoded = Base64.decode(unescaped.replaceAll(armorLine, "").replace(/\s+/g, ""))
  if (Result.isFailure(decoded)) {
    return Result.fail("The key isn't base64 text, with or without PEM armor")
  }
  // A buffer of its own, as Web Crypto reads.
  return Result.succeed({ der: new Uint8Array(decoded.success), form: label === "RSA PRIVATE KEY" ? "pkcs1" : "pkcs8" })
}
