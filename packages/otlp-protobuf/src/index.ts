/**
 * Reads OpenTelemetry's OTLP/HTTP exports of traces and logs, protobuf bodies, into plain data,
 * writes such data back as exports, and writes the answers exporters expect.
 */
export type { AnyValue, Attributes, InstrumentationScope, Resource } from "./common.ts"
export { exportResponse, protobufContentType } from "./export-response.ts"
export type { PartialSuccess } from "./export-response.ts"
export { SpanId, TraceId } from "./ids.ts"
export { decodeLogs, encodeLogs } from "./logs.ts"
export type { LogRecord, ResourceLogs, ScopeLogs } from "./logs.ts"
export { OtlpInvalid } from "./otlp-invalid.ts"
export { decodeTraces, encodeTraces } from "./traces.ts"
export type {
  ResourceSpans,
  ScopeSpans,
  Span,
  SpanEvent,
  SpanKind,
  SpanLink,
  SpanStatus,
  StatusCode,
} from "./traces.ts"
