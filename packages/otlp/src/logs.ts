import { Effect } from "effect"

import type { AnyValue, Attributes, InstrumentationScope, Resource } from "./common.ts"
import {
  emptyResource,
  emptyScope,
  readAttribute,
  readResource,
  readScope,
  readSpanId,
  readTraceId,
  readValue,
  writeAttributes,
  writeResource,
  writeScope,
  writeValue,
} from "./common.ts"
import type { SpanId, TraceId } from "./ids.ts"
import { bytesOfHex } from "./ids.ts"
import { OtlpInvalid } from "./otlp-invalid.ts"
import type { Reader } from "./protobuf-reader.ts"
import {
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

// logs.proto, as OTLP 1.x defines it.

/** One log record. */
export interface LogRecord {
  /** When it happened, in nanoseconds; 0 when the sender didn't say. */
  readonly timeUnixNano: bigint
  /** When the sender's SDK saw it; 0 when it didn't say. */
  readonly observedTimeUnixNano: bigint
  /**
   * OTLP's severity: 1–4 trace, 5–8 debug, 9–12 info, 13–16 warn, 17–20 error, 21–24 fatal; 0 when
   * unknown. Any other number is kept as it was sent.
   */
  readonly severityNumber: number
  /** The level as the sender names it, such as `Warning`; empty when it didn't. */
  readonly severityText: string
  /** What was logged; for most SDKs the formatted message as text. */
  readonly body: AnyValue
  readonly attributes: Attributes
  readonly droppedAttributesCount: number
  /** W3C trace flags in the low 8 bits; 0 when none. */
  readonly flags: number
  /** Absent when the record belongs to no trace. */
  readonly traceId: TraceId | undefined
  readonly spanId: SpanId | undefined
  /** The record's event name, such as .NET's event ID name `ApplicationError`; empty when none. */
  readonly eventName: string
}

/** The log records one instrumentation scope made. */
export interface ScopeLogs {
  /** The logger, such as .NET's category `Microsoft.AspNetCore.Server.Kestrel`. */
  readonly scope: InstrumentationScope
  readonly logRecords: ReadonlyArray<LogRecord>
  /** The semantic conventions' schema the records follow; empty when none. */
  readonly schemaUrl: string
}

/** The log records of one resource, such as one instance of a service, with what describes it. */
export interface ResourceLogs {
  readonly resource: Resource
  readonly scopeLogs: ReadonlyArray<ScopeLogs>
  /** The semantic conventions' schema the resource follows; empty when none. */
  readonly schemaUrl: string
}

// LogRecord: the fields below, by number.
const readLogRecord = (reader: Reader): LogRecord => {
  spend(reader)
  let timeUnixNano = 0n
  let observedTimeUnixNano = 0n
  let severityNumber = 0
  let severityText = ""
  let body: AnyValue = null
  let droppedAttributesCount = 0
  let flags = 0
  let traceId: TraceId | undefined
  let spanId: SpanId | undefined
  let eventName = ""
  const attributes = new Map<string, AnyValue>()
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 1) {
      timeUnixNano = readFixed64(reader)
    } else if (tag.field === 11 && tag.wireType === 1) {
      observedTimeUnixNano = readFixed64(reader)
    } else if (tag.field === 2 && tag.wireType === 0) {
      severityNumber = readInt32(reader)
    } else if (tag.field === 3 && tag.wireType === 2) {
      severityText = readString(reader)
    } else if (tag.field === 5 && tag.wireType === 2) {
      body = readValue(reader)
    } else if (tag.field === 6 && tag.wireType === 2) {
      readAttribute(reader, attributes)
    } else if (tag.field === 7 && tag.wireType === 0) {
      droppedAttributesCount = readUint32(reader)
    } else if (tag.field === 8 && tag.wireType === 5) {
      flags = readFixed32(reader)
    } else if (tag.field === 9 && tag.wireType === 2) {
      traceId = readTraceId(reader, "A log record")
    } else if (tag.field === 10 && tag.wireType === 2) {
      spanId = readSpanId(reader, "A log record")
    } else if (tag.field === 12 && tag.wireType === 2) {
      eventName = readString(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return {
    timeUnixNano,
    observedTimeUnixNano,
    severityNumber,
    severityText,
    body,
    attributes,
    droppedAttributesCount,
    flags,
    traceId,
    spanId,
    eventName,
  }
}

// ScopeLogs: InstrumentationScope scope = 1; repeated LogRecord log_records = 2; string schema_url = 3.
const readScopeLogs = (reader: Reader): ScopeLogs => {
  spend(reader)
  let scope = emptyScope()
  let schemaUrl = ""
  const logRecords: Array<LogRecord> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      scope = readMessage(reader, readScope)
    } else if (tag.field === 2 && tag.wireType === 2) {
      logRecords.push(readMessage(reader, readLogRecord))
    } else if (tag.field === 3 && tag.wireType === 2) {
      schemaUrl = readString(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { scope, logRecords, schemaUrl }
}

// ResourceLogs: Resource resource = 1; repeated ScopeLogs scope_logs = 2; string schema_url = 3.
const readResourceLogs = (reader: Reader): ResourceLogs => {
  spend(reader)
  let resource = emptyResource()
  let schemaUrl = ""
  const scopeLogs: Array<ScopeLogs> = []
  for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
    if (tag.field === 1 && tag.wireType === 2) {
      resource = readMessage(reader, readResource)
    } else if (tag.field === 2 && tag.wireType === 2) {
      scopeLogs.push(readMessage(reader, readScopeLogs))
    } else if (tag.field === 3 && tag.wireType === 2) {
      schemaUrl = readString(reader)
    } else {
      skip(reader, tag.wireType)
    }
  }
  return { resource, scopeLogs, schemaUrl }
}

/**
 * Reads the body of an OTLP/HTTP log export, `ExportLogsServiceRequest` as protobuf, into plain
 * data, every stable field OTLP 1.x defines for logs. Fails with `OtlpInvalid` when the bytes aren't such a
 * message, a record's trace or span ID has the wrong length, or it holds more records and values
 * than one for each 16 bytes. Fields OTLP added later are skipped, so newer exporters still decode.
 * Takes time and memory linear in the body, at most about 25 times its size, which it reads whole:
 * the caller bounds its size.
 */
export const decodeLogs = (body: Uint8Array): Effect.Effect<ReadonlyArray<ResourceLogs>, OtlpInvalid> =>
  Effect.suspend(() => {
    if (!(body instanceof Uint8Array)) {
      return Effect.fail(new OtlpInvalid({ reason: "The body isn't bytes, a Uint8Array" }))
    }
    const reader = readerOf(body)
    const resourceLogs: Array<ResourceLogs> = []
    for (let tag = readTag(reader); tag !== undefined; tag = readTag(reader)) {
      if (tag.field === 1 && tag.wireType === 2) {
        resourceLogs.push(readMessage(reader, readResourceLogs))
      } else {
        skip(reader, tag.wireType)
      }
    }
    return reader.problem === undefined
      ? Effect.succeed(resourceLogs)
      : Effect.fail(new OtlpInvalid({ reason: reader.problem }))
  })

const writeLogRecord = (writer: Writer, record: LogRecord): void =>
  writeMessage(writer, 2, (inner) => {
    writeFixed64Field(inner, 1, record.timeUnixNano)
    writeInt32Field(inner, 2, record.severityNumber)
    writeStringField(inner, 3, record.severityText)
    if (record.body !== null) {
      writeValue(inner, 5, record.body)
    }
    writeAttributes(inner, 6, record.attributes)
    writeUint32Field(inner, 7, record.droppedAttributesCount)
    writeFixed32Field(inner, 8, record.flags)
    if (record.traceId !== undefined) {
      writePresentBytes(inner, 9, bytesOfHex(record.traceId))
    }
    if (record.spanId !== undefined) {
      writePresentBytes(inner, 10, bytesOfHex(record.spanId))
    }
    writeFixed64Field(inner, 11, record.observedTimeUnixNano)
    writeStringField(inner, 12, record.eventName)
  })

/**
 * The protobuf body of an OTLP/HTTP log export of `resourceLogs`, every field included, so
 * `decodeLogs` reads the same data back, unless it holds more than one object for each 16 bytes it
 * takes, which decoding refuses, such as many empty resources. Takes time linear in the data. Holds
 * what OTLP's fields hold: dropped counts and flags from 0 to 2^32 - 1, severities in 32 bits,
 * integer values in 64 bits, times from 0 to 2^64 - 1, well-formed strings, and values nested at
 * most 16 levels; anything else, which no decoded export holds, is a bug and dies, saying which,
 * rather than being written changed.
 */
export const encodeLogs = (resourceLogs: ReadonlyArray<ResourceLogs>): Effect.Effect<Uint8Array> => {
  const writer = writerOf()
  for (const resource of resourceLogs) {
    writeMessage(writer, 1, (inner) => {
      writeResource(inner, 1, resource.resource)
      for (const scopeLogs of resource.scopeLogs) {
        writeMessage(inner, 2, (scopeWriter) => {
          writeScope(scopeWriter, 1, scopeLogs.scope)
          for (const record of scopeLogs.logRecords) {
            writeLogRecord(scopeWriter, record)
          }
          writeStringField(scopeWriter, 3, scopeLogs.schemaUrl)
        })
      }
      writeStringField(inner, 3, resource.schemaUrl)
    })
  }
  return writer.problem === undefined
    ? Effect.succeed(writtenOf(writer))
    : Effect.die(`The logs can't be written as OTLP: ${writer.problem}`)
}
