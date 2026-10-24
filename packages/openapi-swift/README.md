# @bagatka/openapi-swift

Writes a typed Swift 6 client of an HTTP API from its OpenAPI 3.1 document, such as Effect's
`HttpApi` writes, on Foundation alone.

## Install

```sh
npm install @bagatka/openapi-swift effect
```

Its peer dependency is `effect`, at the minor version it is built with. It runs wherever a build
script does: Bun, Node, or Deno. The Swift it writes needs Swift 6.2 or later, and Foundation alone:
it runs on Apple's platforms and on Linux.

## Use it

```ts
import { swiftClient } from "@bagatka/openapi-swift"
import { OpenApi } from "effect/http-api"

// In a build script: the API's own definition, as its document, to the Swift file.
const swift = yield* swiftClient(OpenApi.fromApi(NotesApi)) // the Swift file's text
// Anything it doesn't write fails with UnsupportedOpenApi, listing every problem:
// { path: "#/components/schemas/NoteList/properties/page", reason: "an inline object: name it as a schema of its own" }
```

The Swift it writes, for an API titled Notes:

```swift
let api = NotesAPI(baseURL: url, bearerToken: key, userAgent: "Notes/1.0 (12) iOS/27.1")
do {
    let note = try await api.getNote(id: id)
} catch .noteNotFound(let error) {
    // An error the API names, as its own type.
} catch .unreachable {
    // Offline: keep showing what was there.
} catch {
    // .unreadable or .unwritable: a status or a shape this client doesn't know, and why.
}
```

## Contract

`src/index.ts`. `swiftClient` takes the document as JSON and returns the file, or fails with
`UnsupportedOpenApi`, whose `problems` say where and what to change, every one at once.

## Does not own

- **Running it.** A build script calls `swiftClient` and writes the file where the app's Xcode
  project or Swift package takes it.
- **What to do when a call fails:** one request per call, never retried; offline, the app decides.
- **Authentication** beyond a bearer token, and other headers; a `transport` the app passes can add
  them.

## Depends on

`effect`.

## Decisions and constraints

- **Doesn't trust the document's text.** A document is usually the product's own, but no title,
  description or name in it can write code, and what isn't supported is refused. **Trusts its
  caller,** who chooses the document.
- **What it reads, as Effect's `HttpApi` writes it:** OpenAPI 3.1; named objects, string enums, and
  unions of named objects told apart by the one constant property they share (such as `_tag`, and a
  `discriminator` that names it); arrays, dictionaries, free-form JSON (`{}`), nullable values
  (`anyOf` with null, or a type and null), dates (`format: date-time`), and Effect's numbers, which
  may be `"Infinity"`, `"-Infinity"` or `"NaN"`; path and query parameters of strings, numbers,
  booleans, dates and enums; JSON bodies of any of these; one success status; and errors, 4xx and
  5xx answers of named objects with one constant, all told apart by the same property. Keywords that
  only describe or validate a value, such as `pattern` or `maximum`, are the server's to check.
- **What it refuses,** each with where and why: an inline object, enum or union, which needs a name
  to become a Swift type; `allOf`, `not`, `const`, tuples (`prefixItems`) and any keyword it doesn't
  know; header and cookie parameters, arrays in a query; `default` and ranged responses such as `2XX`;
  a body that isn't JSON or isn't required; an error without a JSON body; a type that holds itself
  other than in an array or a dictionary, which a Swift struct can't; names Swift can't hold, or that
  Swift, Foundation, or the client itself takes, such as `Task`, `URLRequest`, or a property
  `hashValue`; and a path that isn't `/` and segments of letters, digits, `-`, `.`, `_`, `~` and
  `{parameters}`, or holds a segment `.` or `..`, which could send a request, and its bearer token,
  to another address.
- **Effect's names.** Effect names a schema's encoded form `<Name>Encoded`, which is `<Name>` in
  Swift, and its own errors `effect_HttpApiError_<Name>Encoded`, which is
  `EffectHttpApiErrorBadRequest`. A schema named `<Name>_<n>` that is the same as `<Name>`, a copy a
  document names when an operation annotates it, is `<Name>`'s type. Effect 4.0.6 writes a
  `DateTimeUtcFromString` as a plain string, without `format: date-time`, so it is a `String` in
  Swift; and query and path parameters as the strings they are encoded as.
- **Newer servers don't break older apps.** An enum keeps a value it doesn't know, as a struct with
  static values rather than a closed `enum`; a union has an `unknown` case; unknown properties are
  ignored. A missing optional property is `nil`; a required one that may be null is written as
  `null`, never left out. An optional property that may also be null, such as Effect's
  `optionalKey(NullOr(...))`, is `nil` when it is missing or null, and left out when `nil`: the
  client can't send its `null`. Constants are written and checked both ways, so a struct sent on its
  own carries its `_tag`.
- **Swift 6, in any default isolation:** every type is `nonisolated`, so the file compiles in an app
  target whose default is the main actor, as Xcode's new ones are, and in a library; value types are
  `Sendable` and `Hashable`; methods are `@concurrent`, so decoding never runs on the caller's actor;
  errors are typed (`throws(APIError)`). Names that aren't Swift identifiers are raw identifiers,
  `` .`1m` `` (Swift 6.2), and the client's own helpers have names no document's name can be.
- **No text of the document can write code.** Titles and descriptions become comments, their line
  breaks of every kind turned into comment lines; strings are literals with every control character
  escaped; every name, a constant's key included, is checked before it is written.
- **A path parameter is a segment of its own:** its value is escaped, and one that is empty, `.` or
  `..`, which a URL reads as no segment or a step up, is `unwritable` and isn't sent.
- **Checked as Swift.** `bun run check:swift` compiles the clients its tests write with Swift 6,
  warnings as errors, in both default isolations, and runs a round trip that calls the Notes API's
  client through a transport answering as Effect's server does, checking every request, body,
  result, and error against the JSON Effect writes (`test/fixtures/`).
- **Linux too:** it imports `FoundationNetworking` where that exists.
