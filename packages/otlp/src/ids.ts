import { Schema } from "effect"

/** A trace's ID: 16 bytes, as 32 lowercase hex digits, as OpenTelemetry writes it. */
export const TraceId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/)).pipe(Schema.brand("TraceId"))
export type TraceId = typeof TraceId.Type

/** A span's ID: 8 bytes, as 16 lowercase hex digits, as OpenTelemetry writes it. */
export const SpanId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{16}$/)).pipe(Schema.brand("SpanId"))
export type SpanId = typeof SpanId.Type

const hexDigits = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"))

/** Bytes as lowercase hex. */
export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => hexDigits[byte] ?? "").join("")

/** Lowercase hex, as a `TraceId` or `SpanId` holds it, back to its bytes. */
export const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, at) => Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16))
