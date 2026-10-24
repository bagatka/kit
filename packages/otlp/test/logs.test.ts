import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Base64 } from "effect/encoding"

import { decodeLogs, SpanId, TraceId } from "../src/index.ts"
import { bareRecord, everyFieldLogExport, everyFieldLogs } from "./every-field.ts"
import { dotnetLogs } from "./fixtures/dotnet-logs.ts"
import { bytes, encoded, field, key, repeat, varint } from "./protobuf.ts"

const bytesOf = (base64: string) => Effect.fromResult(Base64.decode(base64)).pipe(Effect.orDie)

// An export of one log record made of `fields`, under one resource and one scope.
const logExport = (fields: ReadonlyArray<number>): Uint8Array => Uint8Array.from(field(1, field(2, field(2, fields))))

// An export of `count` empty records, 2 bytes each, under one resource and one scope.
const emptyRecords = (count: number) => Uint8Array.from(field(1, field(2, repeat([0x12, 0x00], count))))

describe("decodeLogs", () => {
  it.effect("reads a .NET export's categories, and its records' time, level, message, trace and exception", () =>
    Effect.gen(function* () {
      const [resource, ...others] = yield* decodeLogs(yield* bytesOf(dotnetLogs))
      assert.isEmpty(others)
      assert.strictEqual(resource?.resource.attributes.get("service.name"), "notes-api")
      assert.deepStrictEqual(
        resource?.scopeLogs.map((scope) => [scope.scope.name, scope.logRecords.length]),
        [
          ["Microsoft.Hosting.Lifetime", 4],
          ["ExportLog", 9],
          ["System.Net.Http.HttpClient.self.LogicalHandler", 6],
          ["System.Net.Http.HttpClient.self.ClientHandler", 6],
          ["Microsoft.AspNetCore.Server.Kestrel", 2],
        ],
      )

      const started = resource?.scopeLogs[1]?.logRecords[0]
      assert.deepInclude(started, {
        timeUnixNano: 1792442983387373000n,
        severityNumber: 9,
        severityText: "Information",
        body: "Export exp-3760 started with 3 notes",
        traceId: TraceId.make("782b83a9114f7ebce1fce192e59a0f7f"),
        spanId: SpanId.make("dddb13203348b70b"),
      })
      assert.strictEqual(started?.attributes.get("NoteCount"), 3n)
      const listening = resource?.scopeLogs[0]?.logRecords[0]
      assert.strictEqual(listening?.eventName, "ListeningOnAddress")
      assert.strictEqual(listening?.traceId, undefined)

      const failure = resource?.scopeLogs[4]?.logRecords[0]
      assert.strictEqual(failure?.severityNumber, 17)
      assert.strictEqual(failure?.attributes.get("exception.message"), "Note store is unavailable")
    }),
  )

  it.effect("reads every field, skipping fields it doesn't know and known ones in another wire type", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* decodeLogs(Uint8Array.from(encoded(everyFieldLogExport, true))), everyFieldLogs)
    }),
  )

  it.effect("reads the fields a message leaves out as their defaults, and an empty ID as none", () =>
    Effect.gen(function* () {
      // A resource and a scope without fields, and a record of nothing but an empty trace ID and
      // span ID.
      const body = Uint8Array.from(
        field(1, [...field(1, []), ...field(2, [...field(1, []), ...field(2, [...field(9, []), ...field(10, [])])])]),
      )
      assert.deepStrictEqual(yield* decodeLogs(body), [
        {
          resource: { attributes: new Map(), droppedAttributesCount: 0 },
          schemaUrl: "",
          scopeLogs: [
            {
              scope: { name: "", version: "", attributes: new Map(), droppedAttributesCount: 0 },
              schemaUrl: "",
              logRecords: [bareRecord],
            },
          ],
        },
      ])
    }),
  )

  it.effect("keeps a severity OTLP doesn't name, negative ones included, as it was sent", () =>
    Effect.gen(function* () {
      // severity_number = -1, an int32 protobuf writes in 10 bytes.
      const [resource] = yield* decodeLogs(logExport([...key(2, 0), ...bytes(9, 0xff), 0x01]))
      assert.strictEqual(resource?.scopeLogs[0]?.logRecords[0]?.severityNumber, -1)
      const [high] = yield* decodeLogs(logExport([...key(2, 0), ...varint(99)]))
      assert.strictEqual(high?.scopeLogs[0]?.logRecords[0]?.severityNumber, 99)
    }),
  )

  it.effect("refuses a body of more records and values than its size allows, and one that isn't bytes", () =>
    Effect.gen(function* () {
      // A body may make one object for each 16 bytes of it, rounded up, and 16 more. These 38
      // bytes make 19: a resource's logs, a scope's logs, and 17 empty records of 2 bytes each; 2
      // bytes more make 20.
      assert.lengthOf(emptyRecords(17), 38)
      assert.lengthOf(yield* decodeLogs(emptyRecords(17)), 1)

      // As do empty records, resources' records and scopes' records by the thousand, where real
      // exports take 30 bytes or more for each.
      const crowded = [
        emptyRecords(18),
        emptyRecords(1000),
        Uint8Array.from(repeat(field(1, []), 1000)),
        Uint8Array.from(field(1, repeat(field(2, []), 1000))),
      ]
      for (const body of crowded) {
        const error = yield* decodeLogs(body).pipe(Effect.flip)
        assert.match(error.reason, /more spans, records and values than 16 bytes each allow/)
      }

      // What a JavaScript caller may pass in place of bytes.
      const fromJavaScript: { decodeLogs(body: unknown): ReturnType<typeof decodeLogs> } = { decodeLogs }
      for (const notBytes of [new DataView(new ArrayBuffer(4)), new ArrayBuffer(4), "body"]) {
        const refused = yield* fromJavaScript.decodeLogs(notBytes).pipe(Effect.flip)
        assert.strictEqual(refused.reason, "The body isn't bytes, a Uint8Array")
      }
    }),
  )

  it.effect("refuses a body cut short, and a record's trace or span ID of the wrong length", () =>
    Effect.gen(function* () {
      const body = yield* bytesOf(dotnetLogs)
      for (const [refused, reason] of [
        [body.subarray(0, 40), /too early/],
        [logExport(field(9, bytes(8, 1))), /^A log record's trace ID is 8 bytes, not 16/],
        [logExport(field(10, bytes(16, 1))), /^A log record's span ID is 16 bytes, not 8/],
      ] as const) {
        const error = yield* decodeLogs(refused).pipe(Effect.flip)
        assert.match(error.reason, reason)
      }
    }),
  )
})
