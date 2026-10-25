/**
 * An ECDSA P-256 signature in strict DER, `SEQUENCE { INTEGER r, INTEGER s }`, as authenticators
 * send it, as Web Crypto takes it: r and s, 32 bytes each. Undefined for any other encoding: a
 * wrong tag or length, an INTEGER that is negative, padded with a zero it doesn't need, or longer
 * than 32 bytes, or bytes after the SEQUENCE. Web Crypto sees only r and s, so this is the only
 * check of the encoding; whether it is the passkey's signature is Web Crypto's to say.
 */
export const rawSignatureOf = (der: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  // At most 2 + 2 × 35 bytes, so the SEQUENCE's length is one byte, under 128.
  if (der[0] !== 0x30 || der[1] !== der.length - 2 || der.length > 72) {
    return undefined
  }
  const r = integerAt(der, 2)
  const s = r === undefined ? undefined : integerAt(der, r.next)
  if (r === undefined || s === undefined || s.next !== der.length) {
    return undefined
  }
  const raw = new Uint8Array(64)
  raw.set(r.value, 32 - r.value.length)
  raw.set(s.value, 64 - s.value.length)
  return raw
}

// The INTEGER's value at `at`, without the zero byte DER puts before a high first byte, and where
// the next element starts; undefined when it isn't one in strict DER, or is longer than 32 bytes.
const integerAt = (der: Uint8Array, at: number) => {
  const length = der[at + 1] ?? 0
  if (der[at] !== 0x02 || length === 0) {
    return undefined
  }
  const value = der.subarray(at + 2, at + 2 + length)
  const first = value[0] ?? 0
  const second = value[1] ?? 0
  // A high first byte is negative; a leading zero is allowed only before a high byte.
  if (first >= 0x80 || (first === 0 && length > 1 && second < 0x80)) {
    return undefined
  }
  const unsigned = first === 0 && length > 1 ? value.subarray(1) : value
  return unsigned.length > 32 ? undefined : { value: unsigned, next: at + 2 + length }
}
