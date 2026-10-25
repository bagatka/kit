import { Effect } from "effect"

import type { AnyValue, Attributes, InstrumentationScope, Resource } from "./common.ts"
import {
  emptyResource,
  emptyScope,
  missingSpanId,
  missingTraceId,
  readAttribute,
  readResource,
  readScope,
  readSpanId,
  readTraceId,
  writeAttributes,
  writeResource,
  writeScope,
} from "./common.ts"
import type { SpanId, TraceId } from "./ids.ts"
import { bytesOfHex } from "./ids.ts"
import { OtlpInvalid } from "./otlp-invalid.ts"
import type { Reader } from "./protobuf-reader.ts"
import {
  fail,
  readerOf,
  readFixed32,
  readFixed64,
  readInt32,
  readMessage,
  readString,
  readTag,
  readUint32,
  skip,
  spend,
} from "./protobuf-reader.ts"
import type { Writer } from "./protobuf-writer.ts"
import {
  refuse,
  writeFixed32Field,
  writeFixed64Field,
  writeInt32Field,
  writeMessage,
  writePresentBytes,
  writeStringField,
  writerOf,
  writeUint32Field,
  writtenOf,
} from "./protobuf-writer.ts"

// trace.proto, as OTLP 1.x defines it.

export type SpanKind = "unspecified" | "internal" | "server" | "client" | "producer" | "consumer"

const spanKinds: ReadonlyArray<SpanKind> = ["unspecified", "internal", "server", "client", "producer", "consumer"]

export type StatusCode = "unset" | "ok" | "error"

const statusCodes: ReadonlyArray<StatusCode> = ["unset", "ok", "error"]

export interface SpanStatus {
  readonly code: StatusCode
  /** Why it failed, when `code` is "error"; otherwise empty. */
  readonly message: string
}

/** Something that happened during a span, such as an exception. */
export interface SpanEvent {
  readonly timeUnixNano: bigint
  readonly name: string
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
}

/** A span of this or another trace that a span relates to, such as a batch's messages. */
export interface SpanLink {
  readonly traceId: TraceId
  readonly spanId: SpanId
  /** W3C trace state, as sent; empty when none. */
  readonly traceState: string
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
  /** W3C trace flags in the low 8 bits, and OTLP's flags above them; 0 when none. */
  readonly flags: number
}

/** One operation of a trace. */
export interface Span {
  readonly traceId: TraceId
  readonly spanId: SpanId
  /** W3C trace state, as sent; empty when none. */
  readonly traceState: string
  /** Absent for a trace's root span. */
  readonly parentSpanId: SpanId | undefined
  /** W3C trace flags in the low 8 bits, and OTLP's flags above them; 0 when none. */
  readonly flags: number
  readonly name: string
  readonly kind: SpanKind
  readonly startTimeUnixNano: bigint
  readonly endTimeUnixNano: bigint
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
  readonly events: ReadonlyArray<SpanEvent>
  readonly droppedEventsCount: number
  readonly links: ReadonlyArray<SpanLink>
  readonly droppedLinksCount: number
  readonly status: SpanStatus
}

/** The spans one instrumentation scope made. */
export interface ScopeSpans {
  readonly scope: InstrumentationScope
  readonly spans: ReadonlyArray<Span>
  /** The semantic conventions' schema the spans follow; empty when none. */
  readonly schemaUrl: string
}

/** The spans of one resource, such as one instance of a service, with what describes it. */
export interface ResourceSpans {
  readonly resource: Resource
  readonly scopeSpans: ReadonlyArray<ScopeSpans>
  /** The semantic conventions' schema the resource follows; empty when none. */
  readonly schemaUrl: string
}

// A closed enum's member by its number; any other number is a problem.
const memberOf = <A>(reader: Reader, members: ReadonlyArray<A>, number: number, what: string): A | undefined => {
  const member = members[number]
  if (member === undefined) {
    fail(reader, `${what} ${number} isn't one OTLP defines`)
  }
  return member
}

// Status: string message = 2; StatusCode code = 3.
const readStatus = (reader: Reader): SpanStatus => {
  let message = ""
  let code: StatusCode = "unset"
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 2 && tag.wireType === 2) {
      message = readString(reader)
    } else if (tag.field === 3 && tag.wireType === 0) {
      code = memberOf(reader, statusCodes, readInt32(reader), "Status code") ?? code
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { code, message }
}

// Event: fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3;
// uint32 dropped_attributes_count = 4.
const readEvent = (reader: Reader): SpanEvent => {
  spend(reader)
  let timeUnixNano = 0n
  let name = ""
  let droppedAttributesCount = 0
  const attributes = new Map<string, AnyValue>()
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 1) {
      timeUnixNano = readFixed64(reader)
    } else if (tag.field === 2 && tag.wireType === 2) {
      name = readString(reader)
    } else if (tag.field === 3 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 4 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { timeUnixNano, name, attributes, droppedAttributesCount }
}

// Link: bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; repeated KeyValue
// attributes = 4; uint32 dropped_attributes_count = 5; fixed32 flags = 6.
const readLink = (reader: Reader): SpanLink => {
  spend(reader)
  let traceId: TraceId | undefined
  let spanId: SpanId | undefined
  let traceState = ""
  let droppedAttributesCount = 0
  let flags = 0
  const attributes = new Map<string, AnyValue>()
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      traceId = readTraceId(reader, "A link")
    } else if (tag.field === 2 && tag.wireType === 2) {
      spanId = readSpanId(reader, "A link")
    } else if (tag.field === 3 && tag.wireType === 2) {
      traceState = readString(reader)
    } else if (tag.field === 4 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 5 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else if (tag.field === 6 && tag.wireType === 5) {
      flags = readFixed32(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  if (traceId === undefined || spanId === undefined) {
    fail(reader, "A link has no trace ID or no span ID")
  }
  return {
    traceId: traceId ?? missingTraceId,
    spanId: spanId ?? missingSpanId,
    traceState,
    attributes,
    droppedAttributesCount,
    flags,
  }
}

// Span: the fields below, by number.
const readSpan = (reader: Reader): Span => {
  spend(reader)
  let traceId: TraceId | undefined
  let spanId: SpanId | undefined
  let traceState = ""
  let parentSpanId: SpanId | undefined
  let flags = 0
  let name = ""
  let kind: SpanKind = "unspecified"
  let startTimeUnixNano = 0n
  let endTimeUnixNano = 0n
  let droppedAttributesCount = 0
  let droppedEventsCount = 0
  let droppedLinksCount = 0
  let status: SpanStatus = { code: "unset", message: "" }
  const attributes = new Map<string, AnyValue>()
  const events: Array<SpanEvent> = []
  const links: Array<SpanLink> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      traceId = readTraceId(reader, "A span")
    } else if (tag.field === 2 && tag.wireType === 2) {
      spanId = readSpanId(reader, "A span")
    } else if (tag.field === 3 && tag.wireType === 2) {
      traceState = readString(reader)
    } else if (tag.field === 4 && tag.wireType === 2) {
      parentSpanId = readSpanId(reader, "A span's parent")
    } else if (tag.field === 16 && tag.wireType === 5) {
      flags = readFixed32(reader)
    } else if (tag.field === 5 && tag.wireType === 2) {
      name = readString(reader)
    } else if (tag.field === 6 && tag.wireType === 0) {
      kind = memberOf(reader, spanKinds, readInt32(reader), "Span kind") ?? kind
    } else if (tag.field === 7 && tag.wireType === 1) {
      startTimeUnixNano = readFixed64(reader)
    } else if (tag.field === 8 && tag.wireType === 1) {
      endTimeUnixNano = readFixed64(reader)
    } else if (tag.field === 9 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 10 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else if (tag.field === 11 && tag.wireType === 2) {
      events.push(readMessage(reader, readEvent))
    } else if (tag.field === 12 && tag.wireType === 0) {
      droppedEventsCount = readUint32(reader)
    } else if (tag.field === 13 && tag.wireType === 2) {
      links.push(readMessage(reader, readLink))
    } else if (tag.field === 14 && tag.wireType === 0) {
      droppedLinksCount = readUint32(reader)
    } else if (tag.field === 15 && tag.wireType === 2) {
      status = readMessage(reader, readStatus)
    } else {
      skip(reader, tag.wireType)
    }
  }
  if (traceId === undefined || spanId === undefined) {
    fail(reader, "A span has no trace ID or no span ID")
  }
  return {
    traceId: traceId ?? missingTraceId,
    spanId: spanId ?? missingSpanId,
    traceState,
    parentSpanId,
    flags,
    name,
    kind,
    startTimeUnixNano,
    endTimeUnixNano,
    attributes,
    droppedAttributesCount,
    events,
    droppedEventsCount,
    links,
    droppedLinksCount,
    status,
  }
}

// ScopeSpans: InstrumentationScope scope = 1; repeated Span spans = 2; string schema_url = 3.
const readScopeSpans = (reader: Reader): ScopeSpans => {
  spend(reader)
  let scope = emptyScope()
  let schemaUrl = ""
  const spans: Array<Span> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      scope = readMessage(reader, readScope)
    } else if (tag.field === 2 && tag.wireType === 2) {
      spans.push(readMessage(reader, readSpan))
    } else if (tag.field === 3 && tag.wireType === 2) {
      schemaUrl = readString(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { scope, spans, schemaUrl }
}

// ResourceSpans: Resource resource = 1; repeated ScopeSpans scope_spans = 2; string schema_url = 3.
const readResourceSpans = (reader: Reader): ResourceSpans => {
  spend(reader)
  let resource = emptyResource()
  let schemaUrl = ""
  const scopeSpans: Array<ScopeSpans> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      resource = readMessage(reader, readResource)
    } else if (tag.field === 2 && tag.wireType === 2) {
      scopeSpans.push(readMessage(reader, readScopeSpans))
    } else if (tag.field === 3 && tag.wireType === 2) {
      schemaUrl = readString(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { resource, scopeSpans, schemaUrl }
}

/**
 * Reads the body of an OTLP/HTTP trace export, `ExportTraceServiceRequest` as protobuf, into plain
 * data, every stable field OTLP 1.x defines for traces. Fails with `OtlpInvalid` when the bytes aren't such
 * a message, a span lacks its IDs or has IDs of the wrong length, or a kind or a status code isn't
 * one OTLP defines, or it holds more spans, events, links and values than one for each 16 bytes.
 * Fields OTLP added later are skipped, so newer exporters still decode. Takes time and memory linear
 * in the body, at most about 25 times its size, which it reads whole: the caller bounds its size.
 */
export const decodeTraces = Effect.fn("decodeTraces")((
  body: Uint8Array,
): Effect.Effect<ReadonlyArray<ResourceSpans>, OtlpInvalid> => {
  if (!(body instanceof Uint8Array)) {
    return Effect.fail(new OtlpInvalid({ reason: "The body isn't bytes, a Uint8Array" }))
  }
  const reader = readerOf(body)
  const resourceSpans: Array<ResourceSpans> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      resourceSpans.push(readMessage(reader, readResourceSpans))
    } else {
      skip(reader, tag.wireType)
    }
  }
  return reader.problem === undefined
    ? Effect.succeed(resourceSpans)
    : Effect.fail(new OtlpInvalid({ reason: reader.problem }))
})

// The number trace.proto gives `name`; one it doesn't name, which only a cast or JavaScript can
// pass, is a problem, as decoding would refuse what was written.
const numberOf = <Name extends string>(
  writer: Writer,
  names: ReadonlyArray<Name>,
  name: Name,
  what: string,
): number => {
  const number = names.indexOf(name)
  if (number === -1) {
    refuse(writer, `A ${what} of ${JSON.stringify(name)} isn't one OTLP names`)
  }
  return number
}

const writeStatus = (writer: Writer, status: SpanStatus): void => {
  if (status.code !== "unset" || status.message !== "") {
    writeMessage(writer, 15, (inner) => {
      writeStringField(inner, 2, status.message)
      writeInt32Field(inner, 3, numberOf(inner, statusCodes, status.code, "status code"))
    })
  }
}

const writeEvent = (writer: Writer, event: SpanEvent): void =>
  writeMessage(writer, 11, (inner) => {
    writeFixed64Field(inner, 1, event.timeUnixNano)
    writeStringField(inner, 2, event.name)
    writeAttributes(inner, 3, event.attributes)
    writeUint32Field(inner, 4, event.droppedAttributesCount)
  })

const writeLink = (writer: Writer, link: SpanLink): void =>
  writeMessage(writer, 13, (inner) => {
    writePresentBytes(inner, 1, bytesOfHex(link.traceId))
    writePresentBytes(inner, 2, bytesOfHex(link.spanId))
    writeStringField(inner, 3, link.traceState)
    writeAttributes(inner, 4, link.attributes)
    writeUint32Field(inner, 5, link.droppedAttributesCount)
    writeFixed32Field(inner, 6, link.flags)
  })

const writeSpan = (writer: Writer, span: Span): void =>
  writeMessage(writer, 2, (inner) => {
    writePresentBytes(inner, 1, bytesOfHex(span.traceId))
    writePresentBytes(inner, 2, bytesOfHex(span.spanId))
    writeStringField(inner, 3, span.traceState)
    if (span.parentSpanId !== undefined) {
      writePresentBytes(inner, 4, bytesOfHex(span.parentSpanId))
    }
    writeStringField(inner, 5, span.name)
    writeInt32Field(inner, 6, numberOf(inner, spanKinds, span.kind, "span kind"))
    writeFixed64Field(inner, 7, span.startTimeUnixNano)
    writeFixed64Field(inner, 8, span.endTimeUnixNano)
    writeAttributes(inner, 9, span.attributes)
    writeUint32Field(inner, 10, span.droppedAttributesCount)
    for (const event of span.events) {
      writeEvent(inner, event)
    }
    writeUint32Field(inner, 12, span.droppedEventsCount)
    for (const link of span.links) {
      writeLink(inner, link)
    }
    writeUint32Field(inner, 14, span.droppedLinksCount)
    writeStatus(inner, span.status)
    writeFixed32Field(inner, 16, span.flags)
  })

/**
 * The protobuf body of an OTLP/HTTP trace export of `resourceSpans`, every field included, so
 * `decodeTraces` reads the same data back, unless it holds more than one object for each 16 bytes
 * it takes, which decoding refuses, such as many empty resources. Takes time linear in the data.
 * Holds what OTLP's fields hold: dropped counts and flags from 0 to 2^32 - 1, integer values in 64
 * bits, times from 0 to 2^64 - 1, well-formed strings, span kinds and status codes OTLP names, and
 * values nested at most 16 levels; anything else, which no decoded export holds, is a bug and dies,
 * saying which, rather than being written changed.
 */
export const encodeTraces = Effect.fn("encodeTraces")((
  resourceSpans: ReadonlyArray<ResourceSpans>,
): Effect.Effect<Uint8Array> => {
  const writer = writerOf()
  for (const resource of resourceSpans) {
    writeMessage(writer, 1, (inner) => {
      writeResource(inner, 1, resource.resource)
      for (const scopeSpans of resource.scopeSpans) {
        writeMessage(inner, 2, (scopeWriter) => {
          writeScope(scopeWriter, 1, scopeSpans.scope)
          for (const span of scopeSpans.spans) {
            writeSpan(scopeWriter, span)
          }
          writeStringField(scopeWriter, 3, scopeSpans.schemaUrl)
        })
      }
      writeStringField(inner, 3, resource.schemaUrl)
    })
  }
  return writer.problem === undefined
    ? Effect.succeed(writtenOf(writer))
    : Effect.die(`The traces can't be written as OTLP: ${writer.problem}`)
})
