// PKCS #8's PrivateKeyInfo around a PKCS #1 key (RFC 5208, section 5): version 0, the algorithm
// rsaEncryption (OID 1.2.840.113549.1.1.1) with NULL parameters, and the key as an OCTET STRING.
const versionZero = Uint8Array.of(0x02, 0x01, 0x00)
const rsaEncryption = Uint8Array.of(
  0x30,
  0x0d,
  0x06,
  0x09,
  0x2a,
  0x86,
  0x48,
  0x86,
  0xf7,
  0x0d,
  0x01,
  0x01,
  0x01,
  0x05,
  0x00,
)

/** A PKCS #1 RSA key in PKCS #8, the only form Web Crypto imports, in one new buffer. */
export const wrappedInPkcs8 = (pkcs1: Uint8Array): Uint8Array<ArrayBuffer> => {
  const keyHeader = Uint8Array.of(0x04, ...derLength(pkcs1.length))
  const contentLength = versionZero.length + rsaEncryption.length + keyHeader.length + pkcs1.length
  const outerHeader = Uint8Array.of(0x30, ...derLength(contentLength))
  const wrapped = new Uint8Array(outerHeader.length + contentLength)
  let at = 0
  for (const part of [outerHeader, versionZero, rsaEncryption, keyHeader, pkcs1]) {
    wrapped.set(part, at)
    at += part.length
  }
  return wrapped
}

// A DER length of 256 to 65,535 bytes, which is every length here: an RSA key of 2048 to 8192 bits
// is over 1,000 bytes in PKCS #1, and a key's text is at most 64 KiB. A shorter key is refused by
// its size anyway, once imported.
const derLength = (length: number): ReadonlyArray<number> => [0x82, length >> 8, length & 0xff]
