// Writes protobuf's wire format into one buffer that grows as it fills. Fields at their default
// value are left out, as protobuf 3 does, except where a `present` field says which member of a
// `oneof` is set. A value its field can't hold, which protobuf would wrap or cut, is a problem: the
// first is recorded, and what was written is never returned.

export interface Writer {
  bytes: Uint8Array
  view: DataView
  length: number
  problem: string | undefined
}

export const writerOf = (): Writer => {
  const bytes = new Uint8Array(4096)
  return { bytes, view: new DataView(bytes.buffer), length: 0, problem: undefined }
}

/** Records `problem`, the first one only. */
export const refuse = (writer: Writer, problem: string): void => {
  writer.problem ??= problem
}

// Whether `value`, a number or a bigint, is a whole number from `least` to `most`.
const within = (value: number | bigint, least: bigint, most: bigint): boolean =>
  (typeof value === "bigint" || Number.isSafeInteger(value)) && BigInt(value) >= least && BigInt(value) <= most

const uint32 = 0xff_ff_ff_ffn
const int32 = 0x7f_ff_ff_ffn
const int64 = 0x7f_ff_ff_ff_ff_ff_ff_ffn
const uint64 = 0xff_ff_ff_ff_ff_ff_ff_ffn

/** The bytes written, in a buffer of their own. */
export const writtenOf = (writer: Writer): Uint8Array => writer.bytes.slice(0, writer.length)

// Makes room for `size` more bytes, doubling the buffer as often as that takes.
const reserve = (writer: Writer, size: number): void => {
  const needed = writer.length + size
  if (needed > writer.bytes.length) {
    let capacity = writer.bytes.length * 2
    while (capacity < needed) {
      capacity *= 2
    }
    const bytes = new Uint8Array(capacity)
    bytes.set(writer.bytes.subarray(0, writer.length))
    writer.bytes = bytes
    writer.view = new DataView(bytes.buffer)
  }
}

const varintSizeOf = (value: number): number => {
  let size = 1
  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) {
    size += 1
  }
  return size
}

// A varint of a number from 0 to 2^53, at `at`.
const putVarint = (writer: Writer, at: number, value: number): void => {
  let position = at
  let rest = value
  while (rest >= 0x80) {
    writer.bytes[position] = (rest % 0x80) | 0x80
    rest = Math.floor(rest / 0x80)
    position += 1
  }
  writer.bytes[position] = rest
}

const writeVarint = (writer: Writer, value: number): void => {
  const size = varintSizeOf(value)
  reserve(writer, size)
  putVarint(writer, writer.length, value)
  writer.length += size
}

const writeVarint64 = (writer: Writer, value: bigint): void => {
  reserve(writer, 10)
  let rest = BigInt.asUintN(64, value)
  while (rest >= 0x80n) {
    writer.bytes[writer.length] = Number(rest & 0x7fn) | 0x80
    rest >>= 7n
    writer.length += 1
  }
  writer.bytes[writer.length] = Number(rest)
  writer.length += 1
}

const writeTag = (writer: Writer, field: number, wireType: number): void => writeVarint(writer, field * 8 + wireType)

/** A `uint64` that fits a number, such as the count of what was refused: a whole number from 0, which callers check. */
export const writeVarintField = (writer: Writer, field: number, value: number): void => {
  if (value !== 0) {
    writeTag(writer, field, 0)
    writeVarint(writer, value)
  }
}

/** A `uint32`, such as a dropped count: a whole number from 0 to 2^32 - 1. */
export const writeUint32Field = (writer: Writer, field: number, value: number): void => {
  if (within(value, 0n, uint32)) {
    writeVarintField(writer, field, value)
  } else {
    refuse(writer, `A count of ${value} isn't a whole number from 0 to 2^32 - 1`)
  }
}

/** An `int32` or an enum, negative ones in 10 bytes, as protobuf writes them. */
export const writeInt32Field = (writer: Writer, field: number, value: number): void => {
  if (!within(value, -int32 - 1n, int32)) {
    refuse(writer, `A severity or kind of ${value} isn't a 32-bit integer`)
  } else if (value !== 0) {
    writeTag(writer, field, 0)
    writeVarint64(writer, BigInt(value))
  }
}

/** An `int64` member of a `oneof`, written even when 0. */
export const writePresentInt64 = (writer: Writer, field: number, value: bigint): void => {
  if (!within(value, -int64 - 1n, int64)) {
    refuse(writer, "An integer value is past 64 bits")
  }
  writeTag(writer, field, 0)
  writeVarint64(writer, value)
}

/** A `bool` member of a `oneof`, written even when false. */
export const writePresentBool = (writer: Writer, field: number, value: boolean): void => {
  writeTag(writer, field, 0)
  writeVarint(writer, value ? 1 : 0)
}

/** A `double` member of a `oneof`, written even when 0. */
export const writePresentDouble = (writer: Writer, field: number, value: number): void => {
  writeTag(writer, field, 1)
  reserve(writer, 8)
  writer.view.setFloat64(writer.length, value, true)
  writer.length += 8
}

export const writeFixed64Field = (writer: Writer, field: number, value: bigint): void => {
  if (!within(value, 0n, uint64)) {
    refuse(writer, `A time of ${value} isn't from 0 to 2^64 - 1 nanoseconds`)
  } else if (value !== 0n) {
    writeTag(writer, field, 1)
    reserve(writer, 8)
    writer.view.setBigUint64(writer.length, value, true)
    writer.length += 8
  }
}

export const writeFixed32Field = (writer: Writer, field: number, value: number): void => {
  if (!within(value, 0n, uint32)) {
    refuse(writer, `Flags of ${value} aren't a whole number from 0 to 2^32 - 1`)
  } else if (value !== 0) {
    writeTag(writer, field, 5)
    reserve(writer, 4)
    writer.view.setUint32(writer.length, value, true)
    writer.length += 4
  }
}

/** Length-delimited bytes, written even when empty. */
export const writePresentBytes = (writer: Writer, field: number, bytes: Uint8Array): void => {
  writeTag(writer, field, 2)
  writeVarint(writer, bytes.length)
  reserve(writer, bytes.length)
  writer.bytes.set(bytes, writer.length)
  writer.length += bytes.length
}

/** A string as UTF-8, written even when empty; one with a lone surrogate, which UTF-8 can't hold, is a problem. */
export const writePresentString = (writer: Writer, field: number, text: string): void => {
  if (!text.isWellFormed()) {
    refuse(writer, "A string holds a lone surrogate, which UTF-8 can't hold")
  }
  writePresentBytes(writer, field, utf8.encode(text))
}

export const writeStringField = (writer: Writer, field: number, text: string): void => {
  if (text !== "") {
    writePresentString(writer, field, text)
  }
}

/**
 * An embedded message whose fields `write` writes, written even when empty: an empty message still
 * says it is there. Its length is written before it, so one byte is kept for it, the size of most,
 * and the message moves along when its length takes more.
 */
export const writeMessage = (writer: Writer, field: number, write: (writer: Writer) => void): void => {
  writeTag(writer, field, 2)
  reserve(writer, 1)
  const lengthAt = writer.length
  writer.length += 1
  write(writer)
  const length = writer.length - lengthAt - 1
  const lengthSize = varintSizeOf(length)
  if (lengthSize > 1) {
    reserve(writer, lengthSize - 1)
    writer.bytes.copyWithin(lengthAt + lengthSize, lengthAt + 1, writer.length)
    writer.length += lengthSize - 1
  }
  putVarint(writer, lengthAt, length)
}

declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array }
const encoder = new TextEncoder()
const utf8 = { encode: (text: string) => encoder.encode(text) }
