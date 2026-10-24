// An export of traces and one of logs that set every field OTLP 1.x defines, and leave fields at
// their defaults, as data and as protobuf. The protobuf is worked out by hand from OTLP's .proto
// files (trace.proto, logs.proto, common.proto, resource.proto) and protobuf's encoding: fields in
// the order of their numbers, as protobuf's own serializers write them, with those at their
// default left out. Integers are varints of 7 bits a byte, low bits first, negative ones as 64
// bits in 10 bytes; times are fixed64 and flags fixed32, little-endian; doubles are IEEE 754,
// little-endian; text is UTF-8.

import type { AnyValue, LogRecord, ResourceLogs, ResourceSpans, Span } from "../src/index.ts"
import { SpanId, TraceId } from "../src/index.ts"
import type { Field, Message } from "./protobuf.ts"
import { bytes, message, text } from "./protobuf.ts"

// AnyValue: string_value 1, bool_value 2, int_value 3, double_value 4, array_value 5 (ArrayValue:
// repeated AnyValue values 1), kvlist_value 6 (KeyValueList: repeated KeyValue values 1), and
// bytes_value 7. KeyValue: key 1, value 2.
const stringValue = (utf8: ReadonlyArray<number>) => message([1, 2, utf8])
const boolValue = (value: 0 | 1) => message([2, 0, [value]])
const intValue = (varint: ReadonlyArray<number>) => message([3, 0, varint])
const doubleValue = (littleEndian: ReadonlyArray<number>) => message([4, 1, littleEndian])
const arrayValue = (...values: ReadonlyArray<Message>) =>
  message([5, 2, message(...values.map((value): Field => [1, 2, value]))])
const kvlistValue = (...pairs: ReadonlyArray<Message>) =>
  message([6, 2, message(...pairs.map((pair): Field => [1, 2, pair]))])
const keyValue = (key: string, value: Message) => message([1, 2, text(key)], [2, 2, value])

// Every kind of value, the edges of each included: the integer past 2^53 and the double 3.0 that a
// shared `number` would confuse, the first integer of two bytes, empty text, a byte order mark,
// U+FFFD itself, and nesting.
export const everyValue = new Map<string, AnyValue>([
  ["text", "Careful"],
  ["empty", ""],
  ["marked", `${String.fromCharCode(0xfeff)}marked`],
  ["replacement", String.fromCharCode(0xfffd)],
  ["true", true],
  ["false", false],
  ["big", 2n ** 62n + 1n],
  ["negative", -5n],
  ["zero", 0n],
  ["two bytes", 128n],
  ["three", 3],
  ["ratio", 0.25],
  ["nothing", null],
  ["bytes", new Uint8Array([0, 1, 255])],
  ["list", ["a", 1n, [true]]],
  ["nested", new Map<string, AnyValue>([["inner", new Map<string, AnyValue>([["deeper", 1.5]])]])],
])

const everyValueMessages: ReadonlyArray<Message> = [
  keyValue("text", stringValue(text("Careful"))),
  keyValue("empty", stringValue([])),
  keyValue("marked", stringValue([0xef, 0xbb, 0xbf, ...text("marked")])), // U+FEFF, then "marked"
  keyValue("replacement", stringValue([0xef, 0xbf, 0xbd])), // U+FFFD
  keyValue("true", boolValue(1)),
  keyValue("false", boolValue(0)),
  // 2^62 + 1: 1 in the first 7 bits, none in the next 49, then 2^6 in the ninth byte.
  keyValue("big", intValue([0x81, ...bytes(7, 0x80), 0x40])),
  // -5 as 64 bits, 2^64 - 5: 0x7b in the first 7 bits, then ones up to the 64th.
  keyValue("negative", intValue([0xfb, ...bytes(8, 0xff), 0x01])),
  keyValue("zero", intValue([0x00])),
  keyValue("two bytes", intValue([0x80, 0x01])), // 128: none in the first 7 bits, then 1
  keyValue("three", doubleValue([0, 0, 0, 0, 0, 0, 0x08, 0x40])), // 3.0 is 0x4008000000000000
  keyValue("ratio", doubleValue([0, 0, 0, 0, 0, 0, 0xd0, 0x3f])), // 0.25 is 0x3fd0000000000000
  keyValue("nothing", message()),
  keyValue("bytes", message([7, 2, [0x00, 0x01, 0xff]])),
  keyValue("list", arrayValue(stringValue(text("a")), intValue([0x01]), arrayValue(boolValue(1)))),
  // 1.5 is 0x3ff8000000000000.
  keyValue(
    "nested",
    kvlistValue(keyValue("inner", kvlistValue(keyValue("deeper", doubleValue([0, 0, 0, 0, 0, 0, 0xf8, 0x3f]))))),
  ),
]

export const traceId = TraceId.make("0123456789abcdef0123456789abcdef")
const traceIdBytes = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]
export const spanId = SpanId.make("0123456789abcdef")
const spanIdBytes = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]

const resource = { attributes: new Map([["service.name", "notes-api"]]), droppedAttributesCount: 2 }
// Resource: repeated KeyValue attributes 1; uint32 dropped_attributes_count 2.
const resourceMessage = message([1, 2, keyValue("service.name", stringValue(text("notes-api")))], [2, 0, [2]])

const scope = {
  name: "notes",
  version: "1.2.0",
  attributes: new Map([["library", "notes-sdk"]]),
  droppedAttributesCount: 1,
}
// InstrumentationScope: name 1; version 2; repeated KeyValue attributes 3; dropped_attributes_count 4.
const scopeMessage = message(
  [1, 2, text("notes")],
  [2, 2, text("1.2.0")],
  [3, 2, keyValue("library", stringValue(text("notes-sdk")))],
  [4, 0, [1]],
)

const resourceSchema = "https://opentelemetry.io/schemas/1.44.0"
const scopeSchema = "https://opentelemetry.io/schemas/1.40.0"

/** A span with nothing but its IDs, its other fields at their defaults. */
export const bareSpan = (id: string): Span => ({
  traceId,
  spanId: SpanId.make(id),
  traceState: "",
  parentSpanId: undefined,
  flags: 0,
  name: "",
  kind: "unspecified",
  startTimeUnixNano: 0n,
  endTimeUnixNano: 0n,
  attributes: new Map(),
  droppedAttributesCount: 0,
  events: [],
  droppedEventsCount: 0,
  links: [],
  droppedLinksCount: 0,
  status: { code: "unset", message: "" },
})

export const everyFieldTraces: ReadonlyArray<ResourceSpans> = [
  {
    resource,
    schemaUrl: resourceSchema,
    scopeSpans: [
      {
        scope,
        schemaUrl: scopeSchema,
        spans: [
          {
            traceId,
            spanId,
            traceState: "notes=1",
            parentSpanId: SpanId.make("fedcba9876543210"),
            flags: 0x301,
            name: "POST /notes",
            kind: "consumer",
            startTimeUnixNano: 2n ** 64n - 2n,
            endTimeUnixNano: 2n ** 64n - 1n,
            attributes: everyValue,
            droppedAttributesCount: 3,
            events: [
              {
                timeUnixNano: 1n,
                name: "retry",
                attributes: new Map([["exception.type", "TimeoutError"]]),
                droppedAttributesCount: 4,
              },
            ],
            droppedEventsCount: 5,
            links: [
              {
                traceId: TraceId.make("fedcba9876543210fedcba9876543210"),
                spanId: SpanId.make("0011223344556677"),
                traceState: "notes=2",
                attributes: new Map([["batch.index", 2n]]),
                droppedAttributesCount: 6,
                flags: 1,
              },
            ],
            droppedLinksCount: 2 ** 32 - 1,
            status: { code: "error", message: "Timed out" },
          },
          bareSpan("89abcdef01234567"),
          // A status of a message alone, which its code at its default doesn't leave out.
          { ...bareSpan("76543210fedcba98"), status: { code: "unset", message: "Retried" } },
        ],
      },
    ],
  },
]

// Span: trace_id 1; span_id 2; trace_state 3; parent_span_id 4; name 5; kind 6; fixed64
// start_time_unix_nano 7 and end_time_unix_nano 8; repeated KeyValue attributes 9;
// dropped_attributes_count 10; repeated Event events 11; dropped_events_count 12; repeated Link
// links 13; dropped_links_count 14; Status status 15; fixed32 flags 16.
const spanMessage = message(
  [1, 2, traceIdBytes],
  [2, 2, spanIdBytes],
  [3, 2, text("notes=1")],
  [4, 2, [0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]],
  [5, 2, text("POST /notes")],
  [6, 0, [5]], // SPAN_KIND_CONSUMER
  [7, 1, [0xfe, ...bytes(7, 0xff)]], // 2^64 - 2
  [8, 1, bytes(8, 0xff)], // 2^64 - 1
  ...everyValueMessages.map((pair): Field => [9, 2, pair]),
  [10, 0, [3]],
  // Event: fixed64 time_unix_nano 1; name 2; repeated KeyValue attributes 3; dropped_attributes_count 4.
  [
    11,
    2,
    message(
      [1, 1, [1, 0, 0, 0, 0, 0, 0, 0]],
      [2, 2, text("retry")],
      [3, 2, keyValue("exception.type", stringValue(text("TimeoutError")))],
      [4, 0, [4]],
    ),
  ],
  [12, 0, [5]],
  // Link: trace_id 1; span_id 2; trace_state 3; repeated KeyValue attributes 4;
  // dropped_attributes_count 5; fixed32 flags 6.
  [
    13,
    2,
    message(
      [1, 2, [0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10]],
      [2, 2, [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]],
      [3, 2, text("notes=2")],
      [4, 2, keyValue("batch.index", intValue([0x02]))],
      [5, 0, [6]],
      [6, 5, [1, 0, 0, 0]],
    ),
  ],
  [14, 0, [0xff, 0xff, 0xff, 0xff, 0x0f]], // 2^32 - 1
  // Status: message 2; code 3, STATUS_CODE_ERROR.
  [15, 2, message([2, 2, text("Timed out")], [3, 0, [2]])],
  [16, 5, [0x01, 0x03, 0x00, 0x00]], // 0x301
)

/** `everyFieldTraces` as `ExportTraceServiceRequest`: repeated ResourceSpans resource_spans 1. */
export const everyFieldTraceExport = message([
  1,
  2,
  // ResourceSpans: Resource resource 1; repeated ScopeSpans scope_spans 2; schema_url 3.
  message(
    [1, 2, resourceMessage],
    [
      2,
      2,
      // ScopeSpans: InstrumentationScope scope 1; repeated Span spans 2; schema_url 3.
      message(
        [1, 2, scopeMessage],
        [2, 2, spanMessage],
        [2, 2, message([1, 2, traceIdBytes], [2, 2, [0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67]])],
        [
          2,
          2,
          message(
            [1, 2, traceIdBytes],
            [2, 2, [0x76, 0x54, 0x32, 0x10, 0xfe, 0xdc, 0xba, 0x98]],
            [15, 2, message([2, 2, text("Retried")])],
          ),
        ],
        [3, 2, text(scopeSchema)],
      ),
    ],
    [3, 2, text(resourceSchema)],
  ),
])

/** A log record with every field at its default. */
export const bareRecord: LogRecord = {
  timeUnixNano: 0n,
  observedTimeUnixNano: 0n,
  severityNumber: 0,
  severityText: "",
  body: null,
  attributes: new Map(),
  droppedAttributesCount: 0,
  flags: 0,
  traceId: undefined,
  spanId: undefined,
  eventName: "",
}

export const everyFieldLogs: ReadonlyArray<ResourceLogs> = [
  {
    resource,
    schemaUrl: resourceSchema,
    scopeLogs: [
      {
        scope,
        schemaUrl: scopeSchema,
        logRecords: [
          {
            timeUnixNano: 1n,
            observedTimeUnixNano: 2n,
            severityNumber: -1,
            severityText: "Odd",
            body: "Note 7 saved",
            attributes: new Map([["note.id", 7n]]),
            droppedAttributesCount: 7,
            flags: 1,
            traceId,
            spanId,
            eventName: "NoteSaved",
          },
          bareRecord,
        ],
      },
    ],
  },
]

/** `everyFieldLogs` as `ExportLogsServiceRequest`: repeated ResourceLogs resource_logs 1. */
export const everyFieldLogExport = message([
  1,
  2,
  // ResourceLogs: Resource resource 1; repeated ScopeLogs scope_logs 2; schema_url 3.
  message(
    [1, 2, resourceMessage],
    [
      2,
      2,
      // ScopeLogs: InstrumentationScope scope 1; repeated LogRecord log_records 2; schema_url 3.
      message(
        [1, 2, scopeMessage],
        // LogRecord: fixed64 time_unix_nano 1; severity_number 2; severity_text 3; AnyValue body 5;
        // repeated KeyValue attributes 6; dropped_attributes_count 7; fixed32 flags 8; trace_id 9;
        // span_id 10; fixed64 observed_time_unix_nano 11; event_name 12.
        [
          2,
          2,
          message(
            [1, 1, [1, 0, 0, 0, 0, 0, 0, 0]],
            [2, 0, [...bytes(9, 0xff), 0x01]], // -1 as 64 bits
            [3, 2, text("Odd")],
            [5, 2, stringValue(text("Note 7 saved"))],
            [6, 2, keyValue("note.id", intValue([0x07]))],
            [7, 0, [7]],
            [8, 5, [1, 0, 0, 0]],
            [9, 2, traceIdBytes],
            [10, 2, spanIdBytes],
            [11, 1, [2, 0, 0, 0, 0, 0, 0, 0]],
            [12, 2, text("NoteSaved")],
          ),
        ],
        [2, 2, message()],
        [3, 2, text(scopeSchema)],
      ),
    ],
    [3, 2, text(resourceSchema)],
  ),
])
