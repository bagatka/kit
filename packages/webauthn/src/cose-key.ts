// An ES256 key on P-256 as a COSE_Key, the way authenticators write it in CTAP2's canonical CBOR
// (WebAuthn, section 5.8.5; RFC 9053): a map of five entries, in this order: kty 2 (EC2), alg -7
// (ES256), crv 1 (P-256), x and y, 32 bytes each. 77 bytes in all.
const head = Uint8Array.of(0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20)
const yHead = Uint8Array.of(0x22, 0x58, 0x20)
const coseKeyLength = head.length + 32 + yHead.length + 32

// SubjectPublicKeyInfo for an uncompressed P-256 point (RFC 5480): id-ecPublicKey, prime256v1, and
// a BIT STRING of 0x04, x, y.
const spkiHead = Uint8Array.of(
  0x30,
  0x59,
  0x30,
  0x13,
  0x06,
  0x07,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x02,
  0x01,
  0x06,
  0x08,
  0x2a,
  0x86,
  0x48,
  0xce,
  0x3d,
  0x03,
  0x01,
  0x07,
  0x03,
  0x42,
  0x00,
  0x04,
)

const startsWith = (bytes: Uint8Array, at: number, expected: Uint8Array) =>
  expected.every((byte, index) => bytes[at + index] === byte)

/**
 * The ES256 public key at the start of `bytes`, as SPKI, and how many bytes its COSE_Key took; or
 * undefined when `bytes` doesn't start with one in the form devices write. Whether the point is on
 * the curve is the platform's to check, when the SPKI is imported.
 */
export const publicKeyOf = (
  bytes: Uint8Array,
): { readonly spki: Uint8Array<ArrayBuffer>; readonly length: number } | undefined => {
  if (!startsWith(bytes, 0, head) || !startsWith(bytes, head.length + 32, yHead)) {
    return undefined
  }
  const spki = new Uint8Array(spkiHead.length + 64)
  spki.set(spkiHead)
  spki.set(bytes.subarray(head.length, head.length + 32), spkiHead.length)
  spki.set(bytes.subarray(head.length + 32 + yHead.length, coseKeyLength), spkiHead.length + 32)
  return { spki, length: coseKeyLength }
}

/** The COSE_Key, as devices write it, of an uncompressed P-256 point: 0x04, x, y. For tests' authenticators. */
export const coseKeyOf = (point: Uint8Array): Uint8Array<ArrayBuffer> => {
  const key = new Uint8Array(coseKeyLength)
  key.set(head)
  key.set(point.subarray(1, 33), head.length)
  key.set(yHead, head.length + 32)
  key.set(point.subarray(33, 65), head.length + 32 + yHead.length)
  return key
}
