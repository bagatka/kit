# @bagatka/otlp

Reads and writes OpenTelemetry's OTLP/HTTP protobuf exports of traces and logs, and the answers
exporters expect, with Effect.

## Install

```sh
npm install @bagatka/otlp effect
```

Its peer dependency is `effect`, at the minor version it is built with: your program uses that one
too. It needs only `TextEncoder` and `TextDecoder` from the platform, so it runs everywhere:
Cloudflare Workers, browsers, Deno, Bun, and Node.

## Use it

```ts
import { decodeTraces, exportResponse, protobufContentType } from "@bagatka/otlp"
import { Effect } from "effect"

const receiveTraces = Effect.fn("receiveTraces")(function* (body: Uint8Array) {
  const resources = yield* decodeTraces(body) // the bytes of POST /v1/traces, as many as you accept
  for (const { resource, scopeSpans } of resources) {
    const service = resource.attributes.get("service.name") // "notes-api"
    for (const span of scopeSpans.flatMap((scope) => scope.spans)) {
      // span.name "GET /api/notes/{id}", span.kind "server", span.status.code "error", and
      // span.attributes.get("http.response.status_code") 500n: integers are bigints.
    }
  }
  return yield* exportResponse() // all accepted; sent with the Content-Type protobufContentType
})
```

A body that isn't a trace export fails with `OtlpInvalid`, whose `reason` says what is wrong and at
which byte, such as `The message ends 10 bytes too early, at byte 6727`: answer it with a 400, which
exporters don't send again. `decodeLogs` reads log exports the same way, and `encodeTraces` and
`encodeLogs` write such data back as an export, such as after removing secrets from it
(`const body = yield* encodeLogs(logs)`): decoding what they write gives the same data back.

## Contract

`src/index.ts`. Callers decode trace and log exports into resources, scopes, and spans or records,
encode such data back into exports, and write the answer to an export. Trace and span IDs are
lowercase hex, `TraceId` and `SpanId`; times are nanoseconds as `bigint`; attributes are maps.

## Does not own

- **Metrics.** Not read yet; reading them joins this package when a product reads them.
- **OTLP/JSON, compressed bodies, and gRPC.** A gzipped body is the caller's to decompress, with
  `DecompressionStream`, before decoding it.
- **What an export may be:** its largest size, and which status a refused one gets, are the
  receiver's (OTLP/HTTP: 400 for a body that can't be read, which exporters don't retry; 429 or 503
  to have them retry).
- **Sending telemetry.** Effect's own OTLP exporters send a program's traces, logs, and metrics.

## Depends on

`effect`, for its errors and the ID Schemas; and the platform's `TextEncoder` and `TextDecoder`.

## Decisions and constraints

- **Its own protobuf reader and writer, for the messages OTLP uses.** No dependency: the wire format
  takes a few hundred lines. Fields it doesn't know, such as ones OTLP adds later, are skipped, as
  protobuf requires, so newer exporters still decode; they aren't written back.
- **Lossless for OTLP 1.x traces and logs.** Every stable field is read, trace state, links, flags, scope
  attributes, dropped counts and schema URLs included, and every field is written, so decoding what
  `encodeTraces` or `encodeLogs` wrote gives the same data, unless it is denser than decoding takes
  (below). The bytes may differ from what an exporter sent, such as in the order of fields or the
  padding of lengths; the data doesn't.
- **Encoding writes only what OTLP's fields hold:** dropped counts and flags from 0 to 2^32 - 1,
  severities in 32 bits, integer values in 64 bits, times from 0 to 2^64 - 1 nanoseconds,
  well-formed strings, span kinds and status codes OTLP names, and values nested at most 16 levels.
  Data past them, which no decoded export holds, is a bug, and dies saying which, rather than being
  written wrapped or changed.
- **Integers are `bigint`, doubles `number`,** so an integer past 2^53 and a double such as 3.0
  both come back as they were sent.
- **Strict about what it reads.** Refused, each with a reason: text that isn't UTF-8, a span without
  its IDs, IDs of the wrong length, a span kind or status code OTLP doesn't define, a `uint32` past
  32 bits, field number 0, wire types protobuf 3 doesn't use, varints over 10 bytes, and values
  nested deeper than 16 levels. A severity OTLP doesn't name, negative ones included, is kept as it
  was sent. A byte order mark in text is text, kept where it is.
- **Not supported:** of two attributes with one key, which OTLP forbids, the last is kept; and an
  embedded message given twice, which no exporter writes, is the last one, where protobuf would
  merge the two.
- **Hostile input is normal input.** Decoding never throws and takes time and memory linear in the
  body, which tests check with a megabyte of each worst shape. Every object decoding makes, a span,
  an event, a link, a record, a scope, a resource, a list or map of values, or bytes, must take 16
  bytes of the body or more, and a body that holds more is refused: real exports take 30 or more for
  each. So a decoded body takes at most about 25 times its size in memory on V8, and real exports 3
  to 6 times: a Worker that accepts bodies of up to 4 MB stays far inside its 128 MB. A body that
  isn't a `Uint8Array`, from a JavaScript caller, is refused too. Data made by a program can be
  denser, such as a hundred empty resources in 400 bytes: it encodes, and decoding refuses it.
- **Cost:** an export of 19,000 spans, 6.7 MB, decodes in about 85 ms and encodes in about 56 ms
  (Bun on an M-series Mac); encoding writes into one buffer that grows as it fills.
- **Tested on real exports,** captured from OpenTelemetry .NET 1.19.1 (`test/fixtures/`), including
  its padded length prefixes and flags.
