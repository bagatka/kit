import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { Base64 } from "effect/encoding"

import type { Span } from "../src/index.ts"
import { decodeTraces, SpanId, TraceId } from "../src/index.ts"
import { everyFieldTraceExport, everyFieldTraces } from "./every-field.ts"
import { dotnetTracesWithExceptions } from "./fixtures/dotnet-traces-with-exceptions.ts"
import { dotnetTraces } from "./fixtures/dotnet-traces.ts"
import { bytes, encoded, field, key, repeat, spanIds, text, traceExport, varint } from "./protobuf.ts"

declare const performance: { readonly now: () => number }

const bytesOf = (base64: string) => Effect.fromResult(Base64.decode(base64)).pipe(Effect.orDie)

const spansOf = (base64: string) =>
  bytesOf(base64).pipe(
    Effect.flatMap(decodeTraces),
    Effect.map((resources) => resources.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))),
  )

const withId = (spans: ReadonlyArray<Span>, spanId: string) => spans.find((span) => span.spanId === spanId)

// A value nested `levels` deep by `wrap`: AnyValue { array_value (5): ArrayValue { values (1):
// AnyValue { ... } } }, or AnyValue { kvlist_value (6): KeyValueList { values (1): KeyValue {
// value (2): ... } } }.
const nested = (levels: number, wrap: (inner: Array<number>) => Array<number>) =>
  Array.from({ length: levels }).reduce<Array<number>>((inner) => wrap(inner), field(1, text("deep")))
const inList = (inner: Array<number>) => field(5, field(1, inner))
const inMap = (inner: Array<number>) => field(6, field(1, [...field(1, text("k")), ...field(2, inner)]))

// A span's attribute of `value`.
const attribute = (value: Array<number>) => field(9, [...field(1, text("k")), ...field(2, value)])

// A link's own IDs, which every link has.
const linkIds: ReadonlyArray<number> = [...field(1, bytes(16, 0x12)), ...field(2, bytes(8, 0x34))]

describe("decodeTraces", () => {
  it.effect("reads a .NET export's resource, scopes and spans exactly", () =>
    Effect.gen(function* () {
      const [resource, ...others] = yield* decodeTraces(yield* bytesOf(dotnetTraces))
      assert.isEmpty(others)
      assert.strictEqual(resource?.resource.attributes.get("service.name"), "notes-api")
      assert.strictEqual(resource?.resource.attributes.get("service.version"), "2.4.0+312")
      assert.strictEqual(resource?.schemaUrl, "https://opentelemetry.io/schemas/1.44.0")
      assert.deepStrictEqual(
        resource?.scopeSpans.map((scope) => [scope.scope.name, scope.spans.length]),
        [
          ["Microsoft.AspNetCore", 16],
          ["System.Net.Http", 3],
        ],
      )

      const spans = yield* spansOf(dotnetTraces)
      const request = withId(spans, "6ca9ea5436af6a02")
      assert.deepInclude(request, {
        traceId: TraceId.make("3d4a2030aab208ac7e247302407bdefb"),
        parentSpanId: undefined,
        // Sampled, and saying whether its parent is remote: it has none.
        flags: 0x103,
        name: "GET /api/notes/{id}",
        kind: "server",
        startTimeUnixNano: 1792442983314811000n,
        endTimeUnixNano: 1792442983346922000n,
        status: { code: "unset", message: "" },
      })
      // Integers are bigints, so a status code reads as it was sent.
      assert.strictEqual(request?.attributes.get("http.route"), "/api/notes/{id}")
      assert.strictEqual(request?.attributes.get("http.response.status_code"), 200n)
      assert.strictEqual(request?.attributes.get("server.port"), 5099n)
    }),
  )

  it.effect("reads failed requests, nested calls, client spans, and exception events", () =>
    Effect.gen(function* () {
      const spans = yield* spansOf(dotnetTraces)
      assert.strictEqual(spans.length, 19)
      assert.deepStrictEqual(withId(spans, "82e53fac96886def")?.status, { code: "error", message: "" })
      // A request another service made: its parent is in that service, remote.
      assert.strictEqual(withId(spans, "62aeca2afa2c82b5")?.parentSpanId, "c9fd60eb7e99a00d")
      assert.strictEqual(withId(spans, "62aeca2afa2c82b5")?.flags, 0x303)
      assert.strictEqual(withId(spans, "c9fd60eb7e99a00d")?.kind, "client")

      const failed = yield* spansOf(dotnetTracesWithExceptions)
      const events = failed.filter((span) => span.status.code === "error").flatMap((span) => span.events)
      assert.deepStrictEqual(
        events.map((event) => [event.name, event.attributes.get("exception.type")]),
        [
          ["exception", "System.InvalidOperationException"],
          ["exception", "System.InvalidOperationException"],
        ],
      )
    }),
  )

  it.effect("reads every field, skipping fields it doesn't know and known ones in another wire type", () =>
    Effect.gen(function* () {
      const body = Uint8Array.from(encoded(everyFieldTraceExport, true))
      const decoded = yield* decodeTraces(body)
      assert.deepStrictEqual(decoded, everyFieldTraces)
      // What it read is its own: the body can be reused.
      body.fill(0)
      assert.deepStrictEqual(decoded, everyFieldTraces)
      assert.isEmpty(yield* decodeTraces(new Uint8Array(0)))
    }),
  )

  it.effect("reads the fields a message leaves out as their defaults, and an empty ID as none", () =>
    Effect.gen(function* () {
      // No resource and no scope; a span of its IDs, an empty parent span ID, an attribute without
      // key or value, an event without fields, and a link of its IDs.
      const body = traceExport([...spanIds, ...field(4, []), ...field(9, []), ...field(11, []), ...field(13, linkIds)])
      assert.deepStrictEqual(yield* decodeTraces(body), [
        {
          resource: { attributes: new Map(), droppedAttributesCount: 0 },
          schemaUrl: "",
          scopeSpans: [
            {
              scope: { name: "", version: "", attributes: new Map(), droppedAttributesCount: 0 },
              schemaUrl: "",
              spans: [
                {
                  traceId: TraceId.make("ab".repeat(16)),
                  spanId: SpanId.make("cd".repeat(8)),
                  traceState: "",
                  parentSpanId: undefined,
                  flags: 0,
                  name: "",
                  kind: "unspecified",
                  startTimeUnixNano: 0n,
                  endTimeUnixNano: 0n,
                  attributes: new Map([["", null]]),
                  droppedAttributesCount: 0,
                  events: [{ timeUnixNano: 0n, name: "", attributes: new Map(), droppedAttributesCount: 0 }],
                  droppedEventsCount: 0,
                  links: [
                    {
                      traceId: TraceId.make("12".repeat(16)),
                      spanId: SpanId.make("34".repeat(8)),
                      traceState: "",
                      attributes: new Map(),
                      droppedAttributesCount: 0,
                      flags: 0,
                    },
                  ],
                  droppedLinksCount: 0,
                  status: { code: "unset", message: "" },
                },
              ],
            },
          ],
        },
      ])

      // Each export's own, as a caller may change what they hold, and no other export may see that.
      const [first, second] = [yield* decodeTraces(body), yield* decodeTraces(body)]
      assert.notStrictEqual(first[0]?.resource.attributes, second[0]?.resource.attributes)
      assert.notStrictEqual(first[0]?.scopeSpans[0]?.scope.attributes, second[0]?.scopeSpans[0]?.scope.attributes)
    }),
  )

  it.effect("reads each span kind and status code by the name trace.proto gives it", () =>
    Effect.gen(function* () {
      const kinds = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const
      for (const [number, kind] of kinds.entries()) {
        const [resource] = yield* decodeTraces(traceExport([...spanIds, ...key(6, 0), number]))
        assert.strictEqual(resource?.scopeSpans[0]?.spans[0]?.kind, kind)
      }
      const codes = ["unset", "ok", "error"] as const
      for (const [number, code] of codes.entries()) {
        const [resource] = yield* decodeTraces(traceExport([...spanIds, ...field(15, [...key(3, 0), number])]))
        assert.strictEqual(resource?.scopeSpans[0]?.spans[0]?.status.code, code)
      }
    }),
  )

  it.effect("refuses what isn't a trace export, saying what is wrong and at which byte", () =>
    Effect.gen(function* () {
      const body = yield* bytesOf(dotnetTraces)
      const refused: ReadonlyArray<readonly [Uint8Array, RegExp]> = [
        [body.subarray(0, body.length - 10), /^The message ends 10 bytes too early, at byte \d+$/],
        // Each kind of value cut short: a varint, a length, a fixed64, a fixed32, a double, and a
        // string past the end of its span.
        [Uint8Array.from([...key(1, 0), 0x80]), /^The message ends 1 bytes too early, at byte 2$/],
        [Uint8Array.from([...key(1, 2), 0x80]), /^The message ends 1 bytes too early, at byte 2$/],
        [Uint8Array.from([...key(1, 1), 1, 2, 3]), /^The message ends 5 bytes too early, at byte 1$/],
        [Uint8Array.from([...key(1, 5), 1, 2]), /^The message ends 2 bytes too early, at byte 1$/],
        [
          traceExport([...spanIds, ...field(9, field(2, [...key(4, 1), 1, 2, 3]))]),
          /^The message ends 5 bytes too early/,
        ],
        [traceExport([...spanIds, ...key(5, 2), 10, ...text("abc")]), /^The message ends 7 bytes too early/],
        [Uint8Array.from([0x0b]), /^Wire type 3 isn't one protobuf 3 uses/],
        [Uint8Array.from([0x00]), /^A field's number is 0/],
        // A value and a length of 11 bytes, where 10 may pad one.
        [Uint8Array.from([...key(1, 0), ...bytes(10, 0xff), 0x01]), /^A varint is longer than 10 bytes/],
        [Uint8Array.from([...key(1, 2), ...bytes(10, 0x80), 0x00]), /^A varint is longer than 10 bytes/],
        // A length of 2^53 - 1 is one, too long for the body; 2^53 isn't one.
        [Uint8Array.from([...key(1, 2), ...varint(2 ** 53 - 1)]), /^The message ends \d+ bytes too early/],
        [Uint8Array.from([...key(1, 2), ...varint(2 ** 53)]), /^A length, count or tag is 2\^53 or more/],
        [traceExport([...spanIds, ...field(5, [0x61, 0xff])]), /^A string isn't UTF-8, at byte \d+$/],
        // "a" and the first 3 bytes of a 4-byte character, which read as U+FFFD take 3 bytes too.
        [traceExport([...spanIds, ...field(5, [0x61, 0xf0, 0x9f, 0x98])]), /^A string isn't UTF-8/],
        [traceExport([...field(1, bytes(15, 1)), ...field(2, bytes(8, 1))]), /^A span's trace ID is 15 bytes, not 16/],
        [traceExport([...field(1, bytes(16, 1)), ...field(2, bytes(9, 1))]), /^A span's span ID is 9 bytes, not 8/],
        [traceExport(field(1, bytes(16, 1))), /^A span has no trace ID or no span ID/],
        [traceExport(field(2, bytes(8, 1))), /^A span has no trace ID or no span ID/],
        [traceExport([...spanIds, ...field(4, bytes(7, 1))]), /^A span's parent's span ID is 7 bytes, not 8/],
        [traceExport([...spanIds, ...key(6, 0), 9]), /^Span kind 9 isn't one OTLP defines/],
        [traceExport([...spanIds, ...field(15, [...key(3, 0), 3])]), /^Status code 3 isn't one OTLP defines/],
        [traceExport([...spanIds, ...key(10, 0), ...varint(2 ** 32)]), /^A uint32 is larger than 32 bits/],
        [
          traceExport([...spanIds, ...field(13, [...field(1, bytes(15, 1)), ...field(2, bytes(8, 1))])]),
          /^A link's trace ID is 15 bytes, not 16/,
        ],
        [
          traceExport([...spanIds, ...field(13, [...field(1, bytes(16, 1)), ...field(2, bytes(7, 1))])]),
          /^A link's span ID is 7 bytes, not 8/,
        ],
        [traceExport([...spanIds, ...field(13, field(1, bytes(16, 1)))]), /^A link has no trace ID or no span ID/],
        [traceExport([...spanIds, ...field(13, field(2, bytes(8, 1)))]), /^A link has no trace ID or no span ID/],
        [traceExport([...spanIds, ...attribute(nested(17, inList))]), /nest deeper than 16/],
        [traceExport([...spanIds, ...attribute(nested(17, inMap))]), /nest deeper than 16/],
      ]
      for (const [refusedBody, reason] of refused) {
        const error = yield* decodeTraces(refusedBody).pipe(Effect.flip)
        assert.strictEqual(error._tag, "OtlpInvalid")
        assert.match(error.reason, reason)
        assert.strictEqual(error.message, `The body isn't an OTLP export: ${error.reason}`)
      }
      // Values nested 16 levels, the most there may be, are read.
      for (const wrap of [inList, inMap]) {
        assert.lengthOf(yield* decodeTraces(traceExport([...spanIds, ...attribute(nested(16, wrap))])), 1)
      }

      // What a JavaScript caller may pass in place of bytes.
      const fromJavaScript: { decodeTraces(body: unknown): ReturnType<typeof decodeTraces> } = { decodeTraces }
      const notBytes = yield* fromJavaScript.decodeTraces("body").pipe(Effect.flip)
      assert.strictEqual(notBytes.reason, "The body isn't bytes, a Uint8Array")
    }),
  )

  it.effect("refuses a body of more spans, events, links, scopes, resources and values than its size allows", () =>
    Effect.gen(function* () {
      const emptyEvent = field(11, [])
      const crowded: ReadonlyArray<Uint8Array> = [
        // Empty messages of each kind, 2 bytes each.
        Uint8Array.from(repeat(field(1, []), 1000)),
        Uint8Array.from(field(1, repeat(field(1, []), 1000))),
        Uint8Array.from(field(1, repeat(field(2, []), 1000))),
        Uint8Array.from(field(1, field(2, repeat(field(1, []), 1000)))),
        traceExport([...spanIds, ...repeat(emptyEvent, 1000)]),
        traceExport([...spanIds, ...field(9, field(2, repeat(field(5, []), 1000)))]),
        traceExport([...spanIds, ...field(9, field(2, repeat(field(6, []), 1000)))]),
        // Empty bytes in a list, 4 bytes each, each of which decodes as bytes of its own.
        traceExport([...spanIds, ...attribute(field(5, repeat(field(1, field(7, [])), 1000)))]),
        // A span and two events, or a link and two events: 34 bytes for three, which would be 17
        // bytes for each of the others.
        Uint8Array.from(field(1, field(2, repeat(field(2, [...spanIds, ...emptyEvent, ...emptyEvent]), 100)))),
        traceExport([...spanIds, ...repeat([...field(13, linkIds), ...emptyEvent, ...emptyEvent], 100)]),
      ]
      for (const body of crowded) {
        const error = yield* decodeTraces(body).pipe(Effect.flip)
        assert.match(error.reason, /more spans, records and values than 16 bytes each allow/)
      }
    }),
  )

  it.effect("takes time linear in the body, whatever it holds", () =>
    Effect.gen(function* () {
      const megabyte = 1 << 20
      const fill = (piece: ReadonlyArray<number>) => repeat(piece, Math.ceil(megabyte / piece.length))
      const atLimit = Array.from({ length: 16 }).reduce<Array<number>>(
        (inner) => field(5, field(1, inner)),
        field(1, text("x")),
      )
      const worst: ReadonlyArray<Uint8Array> = [
        // A megabyte of unknown fields, of tiny attributes, and of values nested to the limit.
        Uint8Array.from(fill([...key(99, 0), 1])),
        traceExport([...spanIds, ...fill(field(9, [...field(1, text("k")), ...field(2, field(1, text("v")))]))]),
        traceExport([...spanIds, ...fill(field(9, [...field(1, text("k")), ...field(2, atLimit)]))]),
      ]
      for (const body of worst) {
        const start = performance.now()
        yield* decodeTraces(body).pipe(Effect.exit)
        assert.isBelow(performance.now() - start, 2_000)
      }
    }),
  )
})

describe("TraceId and SpanId", () => {
  it("are lowercase hex of 16 and 8 bytes, and nothing else", () => {
    const hex = "0123456789abcdef"
    for (const [schema, digits] of [
      [TraceId, hex + hex],
      [SpanId, hex],
    ] as const) {
      assert.isTrue(Schema.is(schema)(digits))
      for (const other of [digits.toUpperCase(), digits.slice(1), `${digits}0`, `x${digits}`, `${digits}x`]) {
        assert.isFalse(Schema.is(schema)(other))
      }
    }
  })
})
