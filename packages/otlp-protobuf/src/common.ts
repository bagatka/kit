import { SpanId, TraceId, hexOf } from "./ids.ts"
import type { Reader } from "./protobuf-reader.ts"
import {
  fail,
  readBytes,
  readDouble,
  readInt64,
  readMessage,
  readString,
  readTag,
  readUint32,
  readVarint,
  skip,
  spend,
} from "./protobuf-reader.ts"
import type { Writer } from "./protobuf-writer.ts"
import {
  refuse,
  writeMessage,
  writePresentBool,
  writePresentBytes,
  writePresentDouble,
  writePresentInt64,
  writePresentString,
  writeStringField,
  writeUint32Field,
} from "./protobuf-writer.ts"

// The messages traces and logs share (common.proto, resource.proto): attributes, resources, and
// instrumentation scopes.

/**
 * An attribute's value, or a log's body. An integer is a `bigint` and a double a `number`, so both
 * come back as they were sent; `null` is OTLP's empty value.
 */
export type AnyValue =
  | string
  | boolean
  | bigint
  | number
  | Uint8Array
  | null
  | ReadonlyArray<AnyValue>
  | ReadonlyMap<string, AnyValue>

/** Attributes by key; of two with one key, the last. A map, so no key can be a prototype's. */
export type Attributes = ReadonlyMap<string, AnyValue>

/** What made the telemetry, such as a library and its version. */
export interface InstrumentationScope {
  readonly name: string
  readonly version: string
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
}

/** What the telemetry is about, such as one instance of a service. */
export interface Resource {
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
}

// A message's scope or resource when it has none: a new one each time, as its map is a caller's to
// change, and one shared by every export decoded would carry one request's changes into the next.
export const emptyScope = (): InstrumentationScope => ({
  name: "",
  version: "",
  attributes: new Map(),
  droppedAttributesCount: 0,
})

export const emptyResource = (): Resource => ({ attributes: new Map(), droppedAttributesCount: 0 })

// Arrays and key-value lists may nest; past this depth a message is refused rather than walked.
const maxValueDepth = 16

// AnyValue is a oneof: string 1, bool 2, int 3, double 4, array 5, kvlist 6, bytes 7. With none of
// them, it is empty.
const readAnyValue = (reader: Reader, depth: number): AnyValue => {
  if (depth > maxValueDepth) {
    fail(reader, `Values nest deeper than ${maxValueDepth} levels`)
    return null
  }
  let value: AnyValue = null
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      value = readString(reader)
    } else if (tag.field === 2 && tag.wireType === 0) {
      value = readVarint(reader) !== 0
    } else if (tag.field === 3 && tag.wireType === 0) {
      value = readInt64(reader)
    } else if (tag.field === 4 && tag.wireType === 1) {
      value = readDouble(reader)
    } else if (tag.field === 5 && tag.wireType === 2) {
      value = readMessage(reader, (inner) => readArrayValue(inner, depth + 1))
    } else if (tag.field === 6 && tag.wireType === 2) {
      value = readMessage(reader, (inner) => readKeyValues(inner, depth + 1, new Map()))
    } else if (tag.field === 7 && tag.wireType === 2) {
      spend(reader)
      value = readBytes(reader).slice()
    } else {
      skip(reader, tag.wireType)
    }
  }
  return value
}

/** A value of an attribute or a log's body, as an embedded `AnyValue`. */
export const readValue = (reader: Reader): AnyValue => readMessage(reader, (inner) => readAnyValue(inner, 0))

// ArrayValue: repeated AnyValue values = 1.
const readArrayValue = (reader: Reader, depth: number): ReadonlyArray<AnyValue> => {
  spend(reader)
  const values: Array<AnyValue> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      values.push(readMessage(reader, (inner) => readAnyValue(inner, depth)))
    } else {
      skip(reader, tag.wireType)
    }
  }
  return values
}

// KeyValue: string key = 1; AnyValue value = 2.
const readKeyValue = (reader: Reader, depth: number, into: Map<string, AnyValue>): void => {
  let key = ""
  let value: AnyValue = null
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      key = readString(reader)
    } else if (tag.field === 2 && tag.wireType === 2) {
      value = readMessage(reader, (inner) => readAnyValue(inner, depth))
    } else {
      skip(reader, tag.wireType)
    }
  }
  into.set(key, value)
}

// KeyValueList: repeated KeyValue values = 1.
const readKeyValues = (reader: Reader, depth: number, into: Map<string, AnyValue>): Attributes => {
  spend(reader)
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      readMessage(reader, (inner) => readKeyValue(inner, depth, into))
    } else {
      skip(reader, tag.wireType)
    }
  }
  return into
}

/** One `repeated KeyValue` field's entry, into the attributes being read. */
export const readAttribute = (reader: Reader, into: Map<string, AnyValue>): void =>
  readMessage(reader, (inner) => readKeyValue(inner, 0, into))

// InstrumentationScope: string name = 1; string version = 2; repeated KeyValue attributes = 3;
// uint32 dropped_attributes_count = 4.
export const readScope = (reader: Reader): InstrumentationScope => {
  spend(reader)
  let name = ""
  let version = ""
  let droppedAttributesCount = 0
  const attributes = new Map<string, AnyValue>()
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      name = readString(reader)
    } else if (tag.field === 2 && tag.wireType === 2) {
      version = readString(reader)
    } else if (tag.field === 3 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 4 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { name, version, attributes, droppedAttributesCount }
}

// Resource: repeated KeyValue attributes = 1; uint32 dropped_attributes_count = 2.
export const readResource = (reader: Reader): Resource => {
  spend(reader)
  let droppedAttributesCount = 0
  const attributes = new Map<string, AnyValue>()
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 2 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { attributes, droppedAttributesCount }
}

// An ID of `size` bytes as hex, or undefined when the field is empty; any other length is a problem.
const readId = (reader: Reader, of: string, what: string, size: number): string | undefined => {
  const bytes = readBytes(reader)
  if (bytes.length === 0) {
    return undefined
  }
  if (bytes.length !== size) {
    fail(reader, `${of}'s ${what} is ${bytes.length} bytes, not ${size}`)
    return undefined
  }
  return hexOf(bytes)
}

/** A trace ID of 16 bytes, or undefined when the field is empty. */
export const readTraceId = (reader: Reader, of: string): TraceId | undefined => {
  const hex = readId(reader, of, "trace ID", 16)
  return hex === undefined ? undefined : TraceId.make(hex)
}

/** A span ID of 8 bytes, or undefined when the field is empty. */
export const readSpanId = (reader: Reader, of: string): SpanId | undefined => {
  const hex = readId(reader, of, "span ID", 8)
  return hex === undefined ? undefined : SpanId.make(hex)
}

// What a message that failed to read holds in place of an ID it lacks; never returned to a caller.
export const missingTraceId = TraceId.make("0".repeat(32))
export const missingSpanId = SpanId.make("0".repeat(16))

const isAttributes = (value: AnyValue): value is Attributes => value instanceof Map

const writeAnyValue = (writer: Writer, value: AnyValue, depth: number): void => {
  if (depth > maxValueDepth) {
    refuse(writer, `Values nest deeper than ${maxValueDepth} levels, which decoding refuses`)
    return
  }
  if (value === null) {
    return
  }
  if (typeof value === "string") {
    writePresentString(writer, 1, value)
  } else if (typeof value === "boolean") {
    writePresentBool(writer, 2, value)
  } else if (typeof value === "bigint") {
    writePresentInt64(writer, 3, value)
  } else if (typeof value === "number") {
    writePresentDouble(writer, 4, value)
  } else if (value instanceof Uint8Array) {
    writePresentBytes(writer, 7, value)
  } else if (isAttributes(value)) {
    writeMessage(writer, 6, (inner) => writeKeyValues(inner, 1, value, depth + 1))
  } else {
    writeMessage(writer, 5, (inner) => {
      for (const item of value) {
        writeMessage(inner, 1, (itemWriter) => writeAnyValue(itemWriter, item, depth + 1))
      }
    })
  }
}

// Key-value pairs as `repeated KeyValue` field `field`, their values `depth` levels down.
const writeKeyValues = (writer: Writer, field: number, attributes: Attributes, depth: number): void => {
  for (const [key, value] of attributes) {
    writeMessage(writer, field, (inner) => {
      writeStringField(inner, 1, key)
      writeMessage(inner, 2, (valueWriter) => writeAnyValue(valueWriter, value, depth))
    })
  }
}

/** A value as field `field`, an embedded `AnyValue`. */
export const writeValue = (writer: Writer, field: number, value: AnyValue): void =>
  writeMessage(writer, field, (inner) => writeAnyValue(inner, value, 0))

/** Attributes as `repeated KeyValue` field `field`. */
export const writeAttributes = (writer: Writer, field: number, attributes: Attributes): void =>
  writeKeyValues(writer, field, attributes, 0)

export const writeScope = (writer: Writer, field: number, scope: InstrumentationScope): void =>
  writeMessage(writer, field, (inner) => {
    writeStringField(inner, 1, scope.name)
    writeStringField(inner, 2, scope.version)
    writeAttributes(inner, 3, scope.attributes)
    writeUint32Field(inner, 4, scope.droppedAttributesCount)
  })

export const writeResource = (writer: Writer, field: number, resource: Resource): void =>
  writeMessage(writer, field, (inner) => {
    writeAttributes(inner, 1, resource.attributes)
    writeUint32Field(inner, 2, resource.droppedAttributesCount)
  })
