// An attestation object (WebAuthn, section 6.5): CBOR (RFC 8949) of a map of three entries,
// `fmt`, `attStmt` and `authData`. This reads the authenticator data out of it, and skips the
// statement without checking it. Only what authenticators write is read: definite lengths, at
// most `maxDepth` levels, every length within the bytes, each key once, nothing after the map.
// Every item takes at least one byte and is read once, so reading takes time linear in the input,
// and nothing throws.

const maxDepth = 8

// A CBOR item's head: its major type, its argument, and where its content starts; undefined when
// it runs past the bytes, or its length is indefinite (31) or reserved (28 to 30). An argument of
// eight bytes may lose precision past 2^53; as a length, it is past the bytes anyway.
const headAt = (bytes: Uint8Array, at: number) => {
  const initial = bytes[at]
  if (initial === undefined) {
    return undefined
  }
  const major = initial >> 5
  const info = initial & 0x1f
  if (info < 24) {
    return { major, argument: info, next: at + 1 }
  }
  if (info > 27) {
    return undefined
  }
  const size = 1 << (info - 24)
  if (at + 1 + size > bytes.length) {
    return undefined
  }
  let argument = 0
  for (let index = 1; index <= size; index += 1) {
    argument = argument * 256 + (bytes[at + index] ?? 0)
  }
  return { major, argument, next: at + 1 + size }
}

// Where the item at `at` ends, at `depth` levels in; undefined when it isn't one that is read.
const itemEnd = (bytes: Uint8Array, at: number, depth: number): number | undefined => {
  const head = depth > maxDepth ? undefined : headAt(bytes, at)
  if (head === undefined) {
    return undefined
  }
  const { major, argument, next } = head
  switch (major) {
    // Byte and text strings: their content follows.
    case 2:
    case 3:
      return argument <= bytes.length - next ? next + argument : undefined
    // Arrays and maps: their items, two for each entry of a map, follow, each at least a byte.
    case 4:
    case 5: {
      const items = major === 5 ? argument * 2 : argument
      if (items > bytes.length - next) {
        return undefined
      }
      let end: number | undefined = next
      for (let item = 0; item < items && end !== undefined; item += 1) {
        end = itemEnd(bytes, end, depth + 1)
      }
      return end
    }
    // A tag: the item it tags follows.
    case 6:
      return itemEnd(bytes, next, depth + 1)
    // Integers, simple values and floats: the head is the item.
    default:
      return next
  }
}

// The three entries, by key, and the major type of each one's value: a text string, a map, bytes.
const entries = [
  { key: "fmt", major: 3 },
  { key: "attStmt", major: 5 },
  { key: "authData", major: 2 },
].map(({ key, major }) => ({ key: Uint8Array.from(key, (character) => character.charCodeAt(0)), major }))
const authData = 2

// Which of the three keys the text string at `at` is, and where it ends; undefined when it is none.
const keyAt = (bytes: Uint8Array, at: number) => {
  const head = headAt(bytes, at)
  const end = head?.major === 3 ? itemEnd(bytes, at, 1) : undefined
  if (head === undefined || end === undefined) {
    return undefined
  }
  const key = entries.findIndex(
    (entry) =>
      entry.key.length === end - head.next && entry.key.every((byte, index) => bytes[head.next + index] === byte),
  )
  return key === -1 ? undefined : { key, end }
}

/**
 * The authenticator data an attestation object holds, in a buffer of its own; undefined when the
 * bytes aren't one: a map of `fmt`, a text string, `attStmt`, a map, and `authData`, a byte string,
 * each once and in any order, and nothing else. The statement isn't checked.
 */
export const authenticatorDataOf = (object: Uint8Array): Uint8Array<ArrayBuffer> | undefined => {
  const map = headAt(object, 0)
  if (map?.major !== 5 || map.argument !== 3) {
    return undefined
  }
  const seen = new Set<number>()
  let data: Uint8Array<ArrayBuffer> | undefined
  let at = map.next
  for (let entry = 0; entry < 3; entry += 1) {
    const found = keyAt(object, at)
    if (found === undefined || seen.has(found.key)) {
      return undefined
    }
    seen.add(found.key)
    const value = headAt(object, found.end)
    const end = itemEnd(object, found.end, 1)
    if (value === undefined || end === undefined || value.major !== entries[found.key]?.major) {
      return undefined
    }
    if (found.key === authData) {
      data = new Uint8Array(object.subarray(value.next, end))
    }
    at = end
  }
  return at === object.length ? data : undefined
}
