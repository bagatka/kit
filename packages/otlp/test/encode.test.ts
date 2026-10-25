import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Tracer } from "effect"
import { Base64 } from "effect/encoding"

import type { AnyValue, LogRecord, ResourceLogs } from "../src/index.ts"
import {
  decodeLogs,
  decodeTraces,
  encodeLogs,
  encodeTraces,
  exportResponse,
  protobufContentType,
} from "../src/index.ts"
import {
  bareRecord,
  bareSpan,
  everyFieldLogExport,
  everyFieldLogs,
  everyFieldTraceExport,
  everyFieldTraces,
  spanId,
  traceId,
} from "./every-field.ts"
import { dotnetLogs } from "./fixtures/dotnet-logs.ts"
import { dotnetTracesWithExceptions } from "./fixtures/dotnet-traces-with-exceptions.ts"
import { dotnetTraces } from "./fixtures/dotnet-traces.ts"
import { encoded, field, key, text } from "./protobuf.ts"

const bytesOf = (base64: string) => Effect.fromResult(Base64.decode(base64)).pipe(Effect.orDie)

// What an effect that died said, or "".
const deathOf = (exit: Exit.Exit<Uint8Array>): string => {
  const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  return typeof defect === "string" ? defect : ""
}

const scope = { name: "notes", version: "1.2.0", attributes: new Map(), droppedAttributesCount: 0 }
const resource = { attributes: new Map([["service.name", "notes-api"]]), droppedAttributesCount: 0 }

// A value nested `levels` deep by `wrap`.
const nested = (levels: number, wrap: (inner: AnyValue) => AnyValue): AnyValue =>
  Array.from({ length: levels }).reduce<AnyValue>((inner) => wrap(inner), "deep")
const inList = (inner: AnyValue): AnyValue => [inner]
const inMap = (inner: AnyValue): AnyValue => new Map([["in", inner]])

// One record, under one resource and one scope.
const logsOf = (record: LogRecord): Array<ResourceLogs> => [
  { resource, schemaUrl: "", scopeLogs: [{ scope, schemaUrl: "", logRecords: [record] }] },
]

describe("encodeTraces and encodeLogs", () => {
  it.effect(
    "write each field as protobuf does, in the order of their numbers, leaving out those at their defaults",
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual([...(yield* encodeTraces(everyFieldTraces))], encoded(everyFieldTraceExport, false))
        assert.deepStrictEqual([...(yield* encodeLogs(everyFieldLogs))], encoded(everyFieldLogExport, false))
      }),
  )

  it.effect("write what decodes to the same data: .NET's exports", () =>
    Effect.gen(function* () {
      for (const fixture of [dotnetTraces, dotnetTracesWithExceptions]) {
        const decoded = yield* decodeTraces(yield* bytesOf(fixture))
        assert.deepStrictEqual(yield* decodeTraces(yield* encodeTraces(decoded)), decoded)
      }
      const logs = yield* decodeLogs(yield* bytesOf(dotnetLogs))
      assert.deepStrictEqual(yield* decodeLogs(yield* encodeLogs(logs)), logs)
    }),
  )

  it.effect("write every field whole, wherever the buffer they fill grows", () =>
    Effect.gen(function* () {
      // The buffer starts at 4 KB and doubles. A text of these lengths puts each kind of field
      // after it, and the empty resource that ends the export, across the buffer's first end; the
      // last is longer than twice the buffer.
      const lengths = [...Array.from({ length: 200 }, (_, index) => 3900 + index), 10_000]
      for (const length of lengths) {
        const logs: ReadonlyArray<ResourceLogs> = [
          ...logsOf({
            ...bareRecord,
            severityText: "x".repeat(length),
            body: 0.5,
            attributes: new Map([["n", -1n]]),
            droppedAttributesCount: 1,
            flags: 1,
            traceId,
            spanId,
            observedTimeUnixNano: 2n,
          }),
          { resource: { attributes: new Map(), droppedAttributesCount: 0 }, schemaUrl: "", scopeLogs: [] },
        ]
        assert.deepStrictEqual(yield* decodeLogs(yield* encodeLogs(logs)), logs)
      }
    }),
  )
})

describe("encodeTraces and encodeLogs, at the edges of what OTLP's fields hold", () => {
  it.effect("write each field's whole range, and die past either end of it, saying which", () =>
    Effect.gen(function* () {
      const held: ReadonlyArray<Partial<LogRecord>> = [
        { severityNumber: 2 ** 31 - 1 },
        { severityNumber: -(2 ** 31) },
        {
          attributes: new Map([
            ["most", 2n ** 63n - 1n],
            ["least", -(2n ** 63n)],
          ]),
        },
        { timeUnixNano: 2n ** 64n - 1n, observedTimeUnixNano: 2n ** 64n - 1n },
        { droppedAttributesCount: 2 ** 32 - 1, flags: 2 ** 32 - 1 },
        { body: nested(16, inList) },
        { body: nested(16, inMap) },
      ]
      for (const change of held) {
        const logs = logsOf({ ...bareRecord, ...change })
        assert.deepStrictEqual(yield* decodeLogs(yield* encodeLogs(logs)), logs)
      }

      const refused: ReadonlyArray<readonly [string, Partial<LogRecord>]> = [
        ["isn't a 32-bit integer", { severityNumber: 2 ** 31 }],
        ["isn't a 32-bit integer", { severityNumber: -(2 ** 31) - 1 }],
        ["isn't a 32-bit integer", { severityNumber: 1.5 }],
        ["past 64 bits", { attributes: new Map([["big", 2n ** 63n]]) }],
        ["past 64 bits", { attributes: new Map([["big", -(2n ** 63n) - 1n]]) }],
        ["isn't from 0 to 2^64 - 1 nanoseconds", { timeUnixNano: 2n ** 64n }],
        ["isn't from 0 to 2^64 - 1 nanoseconds", { observedTimeUnixNano: -1n }],
        ["isn't a whole number from 0 to 2^32 - 1", { droppedAttributesCount: 2 ** 32 }],
        ["isn't a whole number from 0 to 2^32 - 1", { droppedAttributesCount: -1 }],
        ["isn't a whole number from 0 to 2^32 - 1", { droppedAttributesCount: 1.5 }],
        ["aren't a whole number from 0 to 2^32 - 1", { flags: 2 ** 32 }],
        ["aren't a whole number from 0 to 2^32 - 1", { flags: -1 }],
        ["lone surrogate", { attributes: new Map([[`key${String.fromCharCode(0xd800)}`, "value"]]) }],
        ["nest deeper than 16 levels", { body: nested(17, inList) }],
        ["nest deeper than 16 levels", { body: nested(17, inMap) }],
      ]
      for (const [reason, change] of refused) {
        assert.include(deathOf(yield* encodeLogs(logsOf({ ...bareRecord, ...change })).pipe(Effect.exit)), reason)
      }

      // Spans are written through the same fields, and die the same way.
      const span = { ...bareSpan("0123456789abcdef"), droppedLinksCount: 2 ** 32 }
      const traces = [{ resource, schemaUrl: "", scopeSpans: [{ scope, schemaUrl: "", spans: [span] }] }]
      assert.include(deathOf(yield* encodeTraces(traces).pipe(Effect.exit)), "isn't a whole number from 0 to 2^32 - 1")

      // A span kind or a status code OTLP doesn't name, which only JavaScript or a cast can pass.
      const fromJavaScript: { encodeTraces(data: unknown): ReturnType<typeof encodeTraces> } = { encodeTraces }
      const unnamed: ReadonlyArray<readonly [string, object]> = [
        [`A span kind of "sideways" isn't one OTLP names`, { kind: "sideways" }],
        [`A status code of "fine" isn't one OTLP names`, { status: { code: "fine", message: "" } }],
      ]
      for (const [reason, change] of unnamed) {
        const spans = [{ ...bareSpan("0123456789abcdef"), ...change }]
        const data = [{ resource, schemaUrl: "", scopeSpans: [{ scope, schemaUrl: "", spans }] }]
        assert.include(deathOf(yield* fromJavaScript.encodeTraces(data).pipe(Effect.exit)), reason)
      }
    }),
  )
})

describe("exportResponse", () => {
  it.effect("answers an export: empty when all was accepted, or how many were refused and why", () =>
    Effect.gen(function* () {
      assert.strictEqual(protobufContentType, "application/x-protobuf")
      assert.strictEqual((yield* exportResponse()).length, 0)
      // partial_success 1: rejected 1, 128 as a varint, none in the first 7 bits and then 1; and
      // error_message 2.
      const answer = yield* exportResponse({ rejected: 128, errorMessage: "Spans end before they start" })
      assert.deepStrictEqual(
        [...answer],
        field(1, [...key(1, 0), 0x80, 0x01, ...field(2, text("Spans end before they start"))]),
      )
      // None refused, with a warning: a count of 0 is left out.
      const warning = yield* exportResponse({ rejected: 0, errorMessage: "Attribute values were cut short" })
      assert.deepStrictEqual([...warning], field(1, field(2, text("Attribute values were cut short"))))
      for (const rejected of [-1, 1.5, Number.NaN]) {
        const exit = yield* exportResponse({ rejected, errorMessage: "" }).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }
    }),
  )

  it.effect("traces each decode and encode as a span of its own name, and a refused body as its failure", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const traced = Effect.gen(function* () {
        yield* decodeTraces(yield* encodeTraces(everyFieldTraces))
        yield* decodeLogs(yield* encodeLogs(everyFieldLogs))
        yield* decodeTraces(Uint8Array.of(0x0a, 0x05)).pipe(Effect.ignore)
      }).pipe(Effect.provideService(Tracer.Tracer, tracer))
      yield* traced
      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["encodeTraces", "decodeTraces", "encodeLogs", "decodeLogs", "decodeTraces"],
      )
      const outcomes = spans.map((span) => span.status._tag === "Ended" && Exit.isFailure(span.status.exit))
      assert.deepStrictEqual(outcomes, [false, false, false, false, true])
    }),
  )
})
