// Writes the protobuf shapes the tests build by hand.

export const varint = (value: number): Array<number> => {
  const bytes: Array<number> = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) + 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return bytes
}

/** A field's key: its number and wire type. */
export const key = (number: number, wireType: number): Array<number> => varint(number * 8 + wireType)

/** A length-delimited field. */
export const field = (number: number, content: ReadonlyArray<number>): Array<number> => [
  ...key(number, 2),
  ...varint(content.length),
  ...content,
]

export const text = (value: string): Array<number> => Array.from(value, (character) => character.charCodeAt(0))

/** `count` bytes of `byte`, such as an ID. */
export const bytes = (count: number, byte: number): Array<number> => Array.from({ length: count }, () => byte)

/** `piece`, `count` times over. */
export const repeat = (piece: ReadonlyArray<number>, count: number): Array<number> =>
  Array.from({ length: count }, () => piece).flat()

/** An export of one span made of `fields`, under one resource and one scope. */
export const traceExport = (fields: ReadonlyArray<number>): Uint8Array =>
  Uint8Array.from(field(1, field(2, field(2, fields))))

/** A span's own IDs, which every span has. */
export const spanIds: ReadonlyArray<number> = [...field(1, bytes(16, 0xab)), ...field(2, bytes(8, 0xcd))]

type WireType = 0 | 1 | 2 | 5

/** A field of a message built by hand: its number, its wire type, and its bytes or the message it holds. */
export type Field = readonly [number: number, wireType: WireType, content: ReadonlyArray<number> | Message]

/** A message built by hand, its fields in the order they are written. */
export interface Message {
  readonly fields: ReadonlyArray<Field>
}

export const message = (...fields: ReadonlyArray<Field>): Message => ({ fields })

// A value of each wire type protobuf 3 uses, of bytes 0x3f, 63, which no field of the tests' data
// holds: read as a key, 0x3f is a wire type protobuf doesn't use, so a reader that takes one for
// something else ends up refusing, or with a value that isn't the data's.
const samples: Readonly<Record<WireType, ReadonlyArray<number>>> = {
  0: [0x3f],
  1: bytes(8, 0x3f),
  2: [0x01, 0x3f],
  5: bytes(4, 0x3f),
}

// What a reader of `built` must skip: each of its fields' numbers in each wire type the field
// doesn't have, and field 99, which no OTLP message has, in each wire type.
const noiseOf = (built: Message): Array<number> =>
  [...new Set([...built.fields.map(([number]) => number), 99])].flatMap((number) =>
    ([0, 1, 2, 5] as const).flatMap((wireType) =>
      built.fields.some((own) => own[0] === number && own[1] === wireType)
        ? []
        : key(number, wireType).concat(samples[wireType]),
    ),
  )

/**
 * The bytes of `built`. With `noise`, every message in it, itself included, holds after its own
 * fields ones a reader must skip: its fields' numbers in other wire types, and a number it doesn't
 * have.
 */
export const encoded = (built: Message, noise: boolean): Array<number> => {
  const own = built.fields.flatMap(([number, wireType, content]) => {
    const value = "fields" in content ? encoded(content, noise) : [...content]
    return [...key(number, wireType), ...(wireType === 2 ? varint(value.length) : []), ...value]
  })
  return noise ? [...own, ...noiseOf(built)] : own
}
