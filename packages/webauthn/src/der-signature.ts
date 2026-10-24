/**
 * An ECDSA P-256 signature in DER, `SEQUENCE { INTEGER r, INTEGER s }`, as authenticators send it,
 * as Web Crypto takes it: r and s, 32 bytes each. Undefined when its INTEGERs don't fit; whether it
 * is the passkey's signature, and so whether its encoding is right, is Web Crypto's to say.
 */
export const rawSignatureOf = (der: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  const r = integerAt(der, 2)
  const s = r === undefined ? undefined : integerAt(der, r.next)
  if (r === undefined || s === undefined) {
    return undefined
  }
  const raw = new Uint8Array(64)
  raw.set(r.value, 32 - r.value.length)
  raw.set(s.value, 64 - s.value.length)
  return raw
}

// The INTEGER's value at `at`, without the zero byte DER puts before a high first byte, and where
// the next element starts; undefined when it is longer than 32 bytes, which wouldn't fit.
const integerAt = (der: Uint8Array, at: number) => {
  const length = der[at + 1] ?? 0
  const value = der.subarray(at + 2, at + 2 + length)
  const unsigned = value[0] === 0 ? value.subarray(1) : value
  return unsigned.length > 32 ? undefined : { value: unsigned, next: at + 2 + length }
}
