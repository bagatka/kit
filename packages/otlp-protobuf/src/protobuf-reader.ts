// Reads protobuf's wire format (https://protobuf.dev/programming-guides/encoding/) from untrusted
// bytes, without throwing: the first problem is recorded and moves the position to the end, so every
// loop over fields stops and later reads return empty values. The caller checks `problem` once.

export interface Reader {
  readonly bytes: Uint8Array
  readonly view: DataView
  readonly end: number
  /** How many more objects reading may make: shared by a message's reader and its parts'. */
  readonly budget: { left: number }
  position: number
  problem: string | undefined
}

// One object, a span, an event, a record, a scope, a resource, a list or map of values, or bytes,
// for each 16 bytes of the body: real exports hold one for each 30 bytes or more, and a body of
// empty messages, 2 bytes each, would otherwise make an object for every 2.
const bytesPerObject = 16

export const readerOf = (bytes: Uint8Array): Reader => ({
  bytes,
  view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  end: bytes.length,
  budget: { left: Math.ceil(bytes.length / bytesPerObject) + 16 },
  position: 0,
  problem: undefined,
})

/** Counts an object reading makes against the body's budget; a problem once it is spent. */
export const spend = (reader: Reader): void => {
  reader.budget.left -= 1
  if (reader.budget.left < 0) {
    fail(reader, `The body holds more spans, records and values than ${bytesPerObject} bytes each allow`)
  }
}

/** Records `problem`, the first one only, and ends the reading. */
export const fail = (reader: Reader, problem: string): void => {
  reader.problem ??= `${problem}, at byte ${reader.position}`
  reader.position = reader.end
}

const need = (reader: Reader, size: number): boolean => {
  const available = reader.end - reader.position
  if (available < size) {
    fail(reader, `The message ends ${size - available} bytes too early`)
    return false
  }
  return true
}

/** A varint as 64 bits, unsigned: 10 bytes at most, which may pad a smaller value. */
const readVarint64 = (reader: Reader): bigint => {
  let value = 0n
  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (!need(reader, 1)) {
      return 0n
    }
    const byte = reader.bytes[reader.position] ?? 0
    reader.position += 1
    value |= BigInt(byte & 0x7f) << shift
    if (byte < 0x80) {
      return BigInt.asUintN(64, value)
    }
  }
  fail(reader, "A varint is longer than 10 bytes")
  return 0n
}

/** A varint that fits a number exactly: a tag, a length, a count. */
export const readVarint = (reader: Reader): number => {
  let value = 0
  for (let shift = 0; shift < 70; shift += 7) {
    if (!need(reader, 1)) {
      return 0
    }
    const byte = reader.bytes[reader.position] ?? 0
    reader.position += 1
    value += (byte & 0x7f) * 2 ** shift
    if (byte < 0x80) {
      if (value > Number.MAX_SAFE_INTEGER) {
        fail(reader, "A length, count or tag is 2^53 or more")
        return 0
      }
      return value
    }
  }
  fail(reader, "A varint is longer than 10 bytes")
  return 0
}

/** An `int64`, such as an attribute's integer. */
export const readInt64 = (reader: Reader): bigint => BigInt.asIntN(64, readVarint64(reader))

/** An `int32` or an enum, which protobuf writes negative ones of in 10 bytes. */
export const readInt32 = (reader: Reader): number => Number(BigInt.asIntN(32, readVarint64(reader)))

/** A `uint32`, such as a dropped count. */
export const readUint32 = (reader: Reader): number => {
  const value = readVarint(reader)
  if (value > 0xff_ff_ff_ff) {
    fail(reader, "A uint32 is larger than 32 bits")
    return 0
  }
  return value
}

export const readFixed64 = (reader: Reader): bigint => {
  if (!need(reader, 8)) {
    return 0n
  }
  const value = reader.view.getBigUint64(reader.position, true)
  reader.position += 8
  return value
}

export const readFixed32 = (reader: Reader): number => {
  if (!need(reader, 4)) {
    return 0
  }
  const value = reader.view.getUint32(reader.position, true)
  reader.position += 4
  return value
}

export const readDouble = (reader: Reader): number => {
  if (!need(reader, 8)) {
    return 0
  }
  const value = reader.view.getFloat64(reader.position, true)
  reader.position += 8
  return value
}

/** A length-delimited field's bytes: a view into the message, not a copy. */
export const readBytes = (reader: Reader): Uint8Array => {
  const length = readVarint(reader)
  if (!need(reader, length)) {
    return new Uint8Array(0)
  }
  const bytes = reader.bytes.subarray(reader.position, reader.position + length)
  reader.position += length
  return bytes
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/** A string field, which protobuf requires to be UTF-8; any other bytes are a problem. */
export const readString = (reader: Reader): string => {
  const start = reader.position
  const bytes = readBytes(reader)
  const text = utf8.decode(bytes)
  // Decoding writes U+FFFD for bytes that aren't UTF-8, and only a text that holds one can differ
  // from its bytes; one that holds U+FFFD itself encodes back to them.
  if (text.includes("\uFFFD") && !sameBytes(utf8.encode(text), bytes)) {
    reader.position = start
    fail(reader, "A string isn't UTF-8")
    return ""
  }
  return text
}

/** Reads an embedded message with `read`, within its length; a problem inside is the parent's. */
export const readMessage = <A>(reader: Reader, read: (inner: Reader) => A): A => {
  const length = readVarint(reader)
  const available = need(reader, length)
  const inner: Reader = {
    bytes: reader.bytes,
    view: reader.view,
    budget: reader.budget,
    end: available ? reader.position + length : reader.position,
    position: reader.position,
    problem: undefined,
  }
  const message = read(inner)
  if (inner.problem !== undefined) {
    reader.problem ??= inner.problem
    reader.position = reader.end
    return message
  }
  reader.position = inner.end
  return message
}

export interface Tag {
  readonly field: number
  readonly wireType: number
}

/** The next field's number and wire type, or undefined at the end of the message. */
export const readTag = (reader: Reader): Tag | undefined => {
  if (reader.position >= reader.end) {
    return undefined
  }
  const key = readVarint(reader)
  if (key < 8) {
    fail(reader, "A field's number is 0")
  }
  return { field: Math.floor(key / 8), wireType: key % 8 }
}

/** Skips a field this decoder doesn't read, as protobuf requires of fields added later. */
export const skip = (reader: Reader, wireType: number): void => {
  switch (wireType) {
    case 0:
      readVarint64(reader)
      return
    case 1:
      readFixed64(reader)
      return
    case 2:
      readBytes(reader)
      return
    case 5:
      readFixed32(reader)
      return
    default:
      fail(reader, `Wire type ${wireType} isn't one protobuf 3 uses`)
  }
}

// Leaves a byte order mark where it is: in a field, it is text like any other.
declare const TextDecoder: new (
  label: "utf-8",
  options: { readonly ignoreBOM: boolean },
) => { readonly decode: (input: Uint8Array) => string }
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array }
const decoder = new TextDecoder("utf-8", { ignoreBOM: true })
const encoder = new TextEncoder()
const utf8 = {
  decode: (bytes: Uint8Array) => decoder.decode(bytes),
  encode: (text: string) => encoder.encode(text),
}
