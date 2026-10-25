import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { Problem, swiftClient, UnsupportedOpenApi } from "../src/index.ts"
import { notesDocument, wire } from "./fixtures/notes-api.ts"
import { oddDocument } from "./fixtures/odd-api.ts"

// The runtime's file reading, which tests outside a runtime with its types can't name: the golden
// files beside the fixtures, which `bun run check:swift` compiles and runs.
declare const process: { readonly getBuiltinModule: (name: "node:fs") => NodeFs }
interface NodeFs {
  readonly readFileSync: (path: URL, encoding: "utf8") => string
}
declare const URL: new (path: string, base: string) => URL
interface URL {
  readonly href: string
}
declare global {
  interface ImportMeta {
    readonly url: string
  }
}

const fixture = (name: string): string =>
  process.getBuiltinModule("node:fs").readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")

const problemsOf = (document: unknown) =>
  swiftClient(document).pipe(
    Effect.flip,
    Effect.map((error) => error.problems.map((problem) => `${problem.path}: ${problem.reason}`)),
  )

const string = { type: "string" } as const
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const constant = (value: string) => ({ type: "string", enum: [value] })
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
// An object of one constant property, as Effect writes a tagged struct or error.
const tagged = (value: string, key = "_tag") => ({
  type: "object",
  properties: { [key]: constant(value) },
  required: [key],
})
// An object that needs a name of its own to become a Swift type.
const inline = { type: "object", properties: { a: string } }

// A schema named Holder of one property, `x`, of `shape`.
const holding = (shape: unknown) => ({ Holder: { type: "object", properties: { x: shape } } })
// An object of these properties, every one required.
const objectOf = (properties: Readonly<Record<string, unknown>>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
})

// A document of these schemas and one operation, which answers with a string unless it says otherwise.
const documentOf = (schemas: Readonly<Record<string, unknown>>, operation: Readonly<Record<string, unknown>> = {}) => ({
  openapi: "3.1.0",
  info: { title: "Notes", version: "1" },
  components: { schemas },
  paths: {
    "/things": {
      get: {
        operationId: "things.list",
        responses: {
          "200": { description: "Things", content: { "application/json": { schema: { type: "string" } } } },
        },
        ...operation,
      },
    },
  },
})

// A document of these paths and schemas.
const documentWith = (paths: Readonly<Record<string, unknown>>, schemas: Readonly<Record<string, unknown>> = {}) => ({
  openapi: "3.1.0",
  info: { title: "Notes", version: "1" },
  components: { schemas },
  paths,
})

describe("swiftClient", () => {
  it.effect("writes the client of an API as Effect's HttpApi documents it, the same every time", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* swiftClient(notesDocument), fixture("NotesAPI.swift"))
      assert.strictEqual(yield* swiftClient(oddDocument), fixture("OddAPI.swift"))
    }),
  )

  it.effect("is tested on what Effect's server sends and takes for that API", () =>
    Effect.gen(function* () {
      const golden = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(fixture("wire.json"))
      assert.deepStrictEqual(yield* wire, golden)
    }),
  )

  it.effect("writes no text of the document where it could end a comment or a string and write code", () =>
    Effect.gen(function* () {
      const swift = yield* swiftClient(oddDocument)
      for (const line of swift.split("\n").filter((text) => text.includes("injected"))) {
        assert.match(line, /^\s*\/\/\/? /, line)
      }
      assert.notInclude(swift, "\r")
      assert.notInclude(swift, "\u2028")
      assert.include(swift, '"note.created \\"quoted\\" \\\\ back"')
      assert.include(swift, '"gone\\u{a}for good"')
      const del = String.fromCharCode(0x7f)
      const lineSeparator = String.fromCharCode(0x2028)
      const paragraphSeparator = String.fromCharCode(0x2029)
      const marked = yield* swiftClient({
        ...documentOf({
          Mark: {
            type: "object",
            properties: { kind: constant(`a${del}b${lineSeparator}c${paragraphSeparator}d`) },
            required: ["kind"],
          },
        }),
        info: { title: "  Notes \n App ", version: "1" },
      })
      assert.include(marked, '.decode(String.self, forKey: .kind) == "a\\u{7f}b\\u{2028}c\\u{2029}d" else {')
      for (const character of [del, lineSeparator, paragraphSeparator]) {
        assert.notInclude(marked, character)
      }
      assert.include(
        marked,
        "// The Notes App API's Swift client, written by @bagatka/openapi-swift from its OpenAPI\n",
      )
      assert.include(marked, "public nonisolated struct NotesAppAPI: Sendable {")
    }),
  )

  it.effect("refuses what it doesn't write, every problem at once, saying where and how to change it", () =>
    Effect.gen(function* () {
      const problems = yield* problemsOf(
        documentOf(
          {
            Inline: { type: "object", properties: { at: { type: "object", properties: { x: { type: "string" } } } } },
            Merged: { allOf: [{ type: "object" }], type: "object", properties: { a: { type: "string" } } },
            Pair: { type: "object", properties: { both: { type: "array", prefixItems: [{ type: "string" }] } } },
            Loop: { type: "object", properties: { next: { $ref: "#/components/schemas/Loop" } }, required: ["next"] },
            Task: { type: "object", properties: { done: { type: "boolean" } } },
            Mixed: { anyOf: [{ $ref: "#/components/schemas/Task" }, { type: "string" }] },
            Self: { type: "object", properties: { self: { type: "string" } } },
          },
          {
            parameters: [
              { name: "tags", in: "query", schema: { type: "array", items: { type: "string" } } },
              { name: "token", in: "header", schema: { type: "string" } },
            ],
            responses: {
              "200": { description: "Things", content: { "application/json": { schema: { type: "string" } } } },
              default: { description: "Any other", content: { "application/json": { schema: { type: "string" } } } },
              "404": { description: "Not found" },
            },
          },
        ),
      )
      assert.deepStrictEqual(problems, [
        "#/components/schemas/Inline/properties/at: an inline object: name it as a schema of its own",
        "#/components/schemas/Merged: the keywords allOf, which no Swift type here holds",
        "#/components/schemas/Pair/properties/both: the keywords prefixItems, which no Swift type here holds",
        "#/components/schemas/Mixed/anyOf/1: a union's members must be named objects",
        "#/components/schemas/Mixed: a union's members must share exactly one constant property, such as _tag",
        "#/paths/~1things/get/parameters/0: a parameter must be a string, a number, a boolean, a date, or an enum",
        "#/paths/~1things/get/parameters/1: only path and query parameters are supported",
        "#/paths/~1things/get/responses/404: an error must have a JSON body, application/json, of a named error",
        "#/paths/~1things/get/responses/default: a response must have a status code: default and ranges such as 2XX aren't supported",
        "#/components/schemas/Self/properties/self: a property's key no Swift name can hold",
        "#/components/schemas/Task: Task is a name the Swift client, Swift or Foundation takes; rename the schema",
        "#/components/schemas/Loop: Loop holds itself, other than in an array or a dictionary: Swift's structs can't",
      ])
    }),
  )

  it.effect("refuses names the Swift file can't hold, and a type that holds itself, after what it can't read", () =>
    Effect.gen(function* () {
      const problems = yield* problemsOf(
        documentOf({
          Loop: {
            type: "object",
            properties: { next: { anyOf: [{ $ref: "#/components/schemas/Loop" }, { type: "null" }] } },
          },
          Task: { type: "object", properties: { done: { type: "boolean" } } },
          Holder: {
            type: "object",
            properties: { self: { type: "string" }, hashValue: { type: "integer" }, "JSON keys": { type: "string" } },
          },
          Values: { type: "string", enum: ["rawValue", "fine", "fine"] },
          Dotted: { type: "object", properties: { kind: { type: "string", enum: ["a.b"] } }, required: ["kind"] },
          Snaked: { type: "object", properties: { kind: { type: "string", enum: ["a_b"] } }, required: ["kind"] },
          Starred: { type: "object", properties: { kind: { type: "string", enum: ["*"] } }, required: ["kind"] },
          Kinds: {
            anyOf: ["Dotted", "Snaked", "Starred"].map((name) => ({ $ref: `#/components/schemas/${name}` })),
          },
        }),
      )
      assert.deepStrictEqual(problems, [
        "#/components/schemas/Holder/properties/self: a property's key no Swift name can hold",
        "#/components/schemas/Holder/properties/hashValue: a property's key Swift's Hashable takes for itself",
        "#/components/schemas/Holder/properties/JSON keys: a property's key the client takes for its own, JSON keys",
        '#/components/schemas/Kinds: "a.b" and "a_b" both make the case aB of the union',
        '#/components/schemas/Kinds: "*" makes no Swift case name of the union: give it a letter',
        "#/components/schemas/Task: Task is a name the Swift client, Swift or Foundation takes; rename the schema",
        "#/components/schemas/Values: its value rawValue can't be a Swift name",
        "#/components/schemas/Values: its value fine is given twice",
        "#/components/schemas/Loop: Loop holds itself, other than in an array or a dictionary: Swift's structs can't",
      ])
    }),
  )

  it.effect("refuses a document that isn't OpenAPI 3.1 with a title, with an error that lists every problem", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(swiftClient({ openapi: "3.0.3", info: {} }))
      assert.deepStrictEqual(yield* Schema.encodeEffect(UnsupportedOpenApi)(error), {
        _tag: "UnsupportedOpenApi",
        problems: [
          { path: "#/openapi", reason: "the document isn't OpenAPI 3.1" },
          { path: "#/info/title", reason: "the document has no title, which names the client" },
        ],
      })
      assert.deepStrictEqual(error.message.split("\n").slice(1), [
        "#/openapi: the document isn't OpenAPI 3.1",
        "#/info/title: the document has no title, which names the client",
      ])
      assert.isFalse(Schema.is(Problem)({ path: "#/openapi" }))
      for (const openapi of ["13.1.0", "3.1.0-rc.1", ["3.1.0"]]) {
        assert.deepStrictEqual(yield* problemsOf({ ...documentOf({}), openapi }), [
          "#/openapi: the document isn't OpenAPI 3.1",
        ])
      }
      yield* swiftClient({ ...documentOf({}), openapi: "3.1.10" })
      for (const document of ["not a document", null, []]) {
        assert.deepStrictEqual(yield* problemsOf(document), ["#: the document isn't a JSON object"])
      }
    }),
  )

  it.effect("reads each shape it supports as its Swift type, past keywords that only describe one", () =>
    Effect.gen(function* () {
      // Every keyword that describes or validates a value without changing its shape, and an extension.
      const described = {
        $comment: "Made up.",
        title: "Text",
        description: "Some text.",
        examples: ["ada"],
        example: "ada",
        default: "ada",
        deprecated: false,
        readOnly: false,
        writeOnly: false,
        externalDocs: { url: "https://notes.example/docs" },
        pattern: "^[a-z]+$",
        minLength: 1,
        maxLength: 64,
        format: "email",
        minimum: 0,
        maximum: 64,
        exclusiveMinimum: 0,
        exclusiveMaximum: 64,
        multipleOf: 1,
        minItems: 0,
        maxItems: 64,
        uniqueItems: true,
        minProperties: 0,
        maxProperties: 64,
        contentEncoding: "base64",
        contentMediaType: "text/plain",
        "x-order": 1,
      }
      const properties = {
        score: { anyOf: [{ type: "number" }, { type: "null" }] },
        either: { type: ["string", "null"] },
        count: { type: ["null", "integer"] },
        maybe: { anyOf: [ref("MaybeText"), { type: "null" }] },
        alias: ref("MaybeText"),
        bag: { type: "object" },
        empty: { type: "object", properties: {} },
        record: ref("Empty"),
        text: { ...described, type: "string" },
        level: { ...ref("Level"), description: "How much." },
      }
      const swift = yield* swiftClient(
        documentOf({
          Holder: { ...described, type: "object", properties, required: Object.keys(properties) },
          MaybeText: { anyOf: [string, { type: "null" }] },
          Empty: { type: "object", properties: {} },
          Level: { ...described, type: "string", enum: ["low", "high"] },
        }),
      )
      assert.include(
        swift,
        [
          "    public let score: Double?",
          "    public let either: String?",
          "    public let count: Int?",
          "    public let maybe: String?",
          "    public let alias: String?",
          "    public let bag: [String: JSONValue]",
          "    public let empty: [String: JSONValue]",
          "    public let record: [String: JSONValue]",
          "    public let text: String",
          "    public let level: Level",
        ].join("\n"),
      )
      // An API that names no errors reads any failing answer as unreadable.
      assert.include(
        swift,
        '    private static func failure(status: Int, data: Data) -> APIError {\n        .unreadable(status: status, reason: "The API names no errors.")\n    }',
      )
    }),
  )

  it.effect("names each schema's type as Effect's names mean, and copies of a schema as the schema", () =>
    Effect.gen(function* () {
      const note = {
        type: "object",
        properties: { title: string, tags: { type: "array", items: string } },
        required: ["title", "tags"],
      }
      const copy = {
        required: ["title", "tags"],
        properties: { tags: { items: string, type: "array" }, title: string },
        type: "object",
      }
      const shared = { type: "object", properties: { body: string } }
      const swift = yield* swiftClient(
        documentOf(
          {
            NoteEncoded: note,
            NoteEncoded_1: copy,
            NoteEncoded_12: copy,
            NoteEncoded_2a: copy,
            Thing: { type: "object", properties: { id: string } },
            ThingEncoded: { type: "object", properties: { id: { type: "integer" } } },
            Encoded: { type: "object", properties: { data: string } },
            Note_Item: { type: "object", properties: { label: string } },
            undefined: { type: "object", properties: { value: string } },
            // The same object under two names, as a caller's own document may have it.
            Shared: shared,
            Shared_1: shared,
          },
          { responses: { "200": { description: "A note", ...json(ref("NoteEncoded_12")) } } },
        ),
      )
      const types = Array.from(
        swift.matchAll(/^public nonisolated struct (\w+): Codable, Hashable, Sendable \{$/gm),
        (match) => match[1],
      )
      assert.deepStrictEqual(types, [
        "Encoded",
        "Note",
        "NoteEncoded2a",
        "NoteItem",
        "Shared",
        "Thing",
        "ThingEncoded",
        "Undefined",
      ])
      assert.include(swift, "    public func list() async throws(APIError) -> Note {")
    }),
  )

  it.effect("reads a union by the one constant its members share, and an error that is a union as its members", () =>
    Effect.gen(function* () {
      const swift = yield* swiftClient(
        documentWith(
          {
            "/shapes": {
              get: {
                operationId: "shapes.list",
                responses: {
                  "200": { description: "Shapes", ...json({ type: "array", items: ref("Shape") }) },
                  "404": { description: "Not found", ...json(ref("Failure")) },
                  "503": { description: "Down", ...json(ref("Unavailable")) },
                },
              },
            },
          },
          {
            Circle: {
              type: "object",
              properties: { kind: constant("round"), _tag: constant("Circle"), radius: { type: "number" } },
              required: ["kind", "_tag", "radius"],
            },
            Square: {
              type: "object",
              properties: { _tag: constant("Square"), kind: constant("square") },
              required: ["_tag", "kind"],
            },
            Dot: tagged("Dot"),
            Shape: { anyOf: [ref("Circle"), ref("Square"), ref("Dot")] },
            NotFound: tagged("NotFound"),
            Conflict: tagged("Conflict"),
            Unavailable: tagged("Unavailable"),
            Failure: { oneOf: [ref("NotFound"), ref("Conflict")], discriminator: { propertyName: "_tag" } },
          },
        ),
      )
      assert.include(
        swift,
        [
          "public nonisolated enum Shape: Codable, Hashable, Sendable {",
          "    case circle(Circle)",
          "    case square(Square)",
          "    case dot(Dot)",
          "    case unknown(String)",
          "",
          "    private enum `JSON keys`: String, CodingKey {",
          '        case kind = "_tag"',
          "    }",
        ].join("\n"),
      )
      assert.include(
        swift,
        [
          "public nonisolated enum APIError: Error, Sendable {",
          "    case conflict(Conflict)",
          "    case notFound(NotFound)",
          "    case unavailable(Unavailable)",
          "    /// The server didn't answer: no connection, a timeout, or a cancelled call.",
        ].join("\n"),
      )
      assert.include(swift, "    /// Fails with `.notFound`, `.conflict`, `.unavailable`, or as any call can.")
    }),
  )

  it.effect(
    "writes each operation's parameters, path first, then its body, then required queries and optional ones",
    () =>
      Effect.gen(function* () {
        const note = { name: "note", in: "path", required: true, schema: string }
        const swift = yield* swiftClient(
          documentWith(
            {
              "/notes/{note}": {
                get: {
                  operationId: "acme.notes.read_note",
                  summary: "Reads a note.",
                  parameters: [
                    { name: "page", in: "query", schema: { type: "integer" } },
                    { name: "q", in: "query", required: true, schema: string },
                    { name: "pinned", in: "query", schema: { type: "boolean" } },
                    { name: "since", in: "query", required: true, schema: { anyOf: [string, { type: "null" }] } },
                    note,
                  ],
                  responses: { "200": { description: "The note", ...json(ref("Note")) } },
                },
                delete: {
                  operationId: "notes._remove_all",
                  description: 42,
                  parameters: [note],
                  responses: { "204": { description: "Removed" } },
                },
              },
              "/notes": {
                get: {
                  operationId: "notes.listEveryNoteThatAnyoneHasEverWrittenAnywhereAtAll",
                  responses: { "200": { description: "Notes", ...json({ type: "array", items: ref("Note") }) } },
                },
                post: {
                  operationId: "notes.createNoteFromEveryDraftNow",
                  requestBody: { required: true, ...json(ref("Note")) },
                  responses: { "200": { description: "The note", ...json(ref("Note")) } },
                },
              },
            },
            { Note: { type: "object", properties: { title: string }, required: ["title"] } },
          ),
        )
        assert.include(
          swift,
          [
            "    /// Reads a note.",
            "    @concurrent",
            "    public func readNote(",
            "        note: String,",
            "        q: String,",
            "        page: Int? = nil,",
            "        pinned: Bool? = nil,",
            "        since: String? = nil,",
            "    ) async throws(APIError) -> Note {",
            "        var `query items`: [(String, String)] = []",
            '        `query items`.append(("q", Self.text(q)))',
            '        if let page { `query items`.append(("page", Self.text(page))) }',
            '        if let pinned { `query items`.append(("pinned", Self.text(pinned))) }',
            '        if let since { `query items`.append(("since", Self.text(since))) }',
            '        let `the answer` = try await self.send("GET", "/notes/\\(Self.segment(Self.text(note)))", query: `query items`)',
          ].join("\n"),
        )
        // A description that isn't text is none.
        assert.include(
          swift,
          "    }\n\n    @concurrent\n    public func removeAll(note: String) async throws(APIError) {\n",
        )
        // A declaration stays on one line up to 100 columns, and one without parameters always does.
        const lines = swift.split("\n")
        assert.include(
          lines,
          "    public func listEveryNoteThatAnyoneHasEverWrittenAnywhereAtAll() async throws(APIError) -> [Note] {",
        )
        const create =
          "    public func createNoteFromEveryDraftNow(_ `request body`: Note) async throws(APIError) -> Note {"
        assert.strictEqual(create.length, 100)
        assert.include(lines, create)
      }),
  )

  it.effect("writes a description as doc comment lines of at most 100 columns, its paragraphs kept", () =>
    Effect.gen(function* () {
      const nextLine = String.fromCharCode(0x85)
      const lineSeparator = String.fromCharCode(0x2028)
      const paragraphSeparator = String.fromCharCode(0x2029)
      const bell = String.fromCharCode(0x07)
      const del = String.fromCharCode(0x7f)
      const address = `https://notes.example/${"n".repeat(78)}`
      const description = [
        "\n\nOne.\r\rTwo.",
        `${nextLine}${nextLine}Three.`,
        `${lineSeparator}${lineSeparator}Four.`,
        `${paragraphSeparator}${paragraphSeparator}Five\nsix${bell}seven${del}eight.`,
        "\n\nLists every note of the account, the newest first, each with its title, its body, its color and tags.",
        `\n \n${address} is where.\n`,
      ].join("")
      const swift = yield* swiftClient(documentOf({}, { description }))
      assert.include(
        swift,
        [
          // Nothing of the blank first paragraph: the comment starts after the line between methods.
          "    }",
          "",
          "    /// One.",
          "    ///",
          "    /// Two.",
          "    ///",
          "    /// Three.",
          "    ///",
          "    /// Four.",
          "    ///",
          "    /// Five six seven eight.",
          "    ///",
          "    /// Lists every note of the account, the newest first, each with its title, its body, its color",
          "    /// and tags.",
          "    ///",
          `    /// ${address}`,
          "    /// is where.",
          "    @concurrent",
          "    public func list() async throws(APIError) -> String {",
        ].join("\n"),
      )
    }),
  )

  it.effect("refuses each shape of a schema it doesn't write, saying where", () =>
    Effect.gen(function* () {
      const x = "#/components/schemas/Holder/properties/x"
      const union = "a union here: name it as a schema of its own"
      const several = "a type of several types, other than one and null"
      const nonFinite = { type: "string", enum: ["NaN", "Infinity", "-Infinity"] }
      const number = { type: "number" }
      const nothing = { type: "null" }
      const shapes = { Circle: tagged("Circle"), Square: tagged("Square") }
      const rows: ReadonlyArray<readonly [Readonly<Record<string, unknown>>, ReadonlyArray<string>]> = [
        [holding(null), [`${x}: a schema must be an object`]],
        [
          holding(ref("Missing")),
          [`${x}: a reference to #/components/schemas/Missing, which isn't one of the document's schemas`],
        ],
        [
          { ...holding({ $ref: "#/definitions/undefined" }), undefined: inline },
          [`${x}: a reference to #/definitions/undefined, which isn't one of the document's schemas`],
        ],
        [
          holding({ ...ref("Holder"), type: "object", nullable: true }),
          [`${x}: a reference with type, nullable beside it`],
        ],
        [
          { ...holding(ref("Chain")), Chain: { type: "array", items: ref("Chain") } },
          ["#/components/schemas/Chain/items: Chain stands for a value that holds itself"],
        ],
        [holding({ anyOf: [string, { type: "integer" }] }), [`${x}: ${union}`]],
        [holding({ anyOf: [string] }), [`${x}: ${union}`]],
        [holding({ oneOf: [inline, nothing] }), [`${x}/oneOf/0: an inline object: name it as a schema of its own`]],
        [holding({ type: ["string", "integer"] }), [`${x}: ${several}`]],
        [holding({ type: ["string", "null", "integer"] }), [`${x}: ${several}`]],
        [holding({ type: ["null"] }), [`${x}: ${several}`]],
        [holding({ type: ["null", "null"] }), [`${x}: ${several}`]],
        [holding({ ...inline, type: ["object", "null"] }), [`${x}: an inline object: name it as a schema of its own`]],
        [holding({ ...inline, required: ["a"] }), [`${x}: an inline object: name it as a schema of its own`]],
        [holding({ type: "string", enum: ["a", "b"] }), [`${x}: an inline enum: name it as a schema of its own`]],
        [
          holding({ type: "array", items: constant("only") }),
          [`${x}/items: a constant here: only an object's property may be one`],
        ],
        [
          holding({ type: "object", additionalProperties: inline }),
          [`${x}/additionalProperties: an inline object: name it as a schema of its own`],
        ],
        [
          holding({ type: "array", items: string, prefixItems: [string], contains: string }),
          [`${x}: the keywords prefixItems, contains, which no Swift type here holds`],
        ],
        [holding({ type: "string", enum: [1, 2] }), [`${x}: an enum of other values than strings`]],
        [holding({ type: "integer", enum: [1, 2] }), [`${x}: an enum of other values than strings`]],
        [holding({ items: string }), [`${x}: a schema with no type`]],
        [holding({ enum: ["only"] }), [`${x}: a schema with no type`]],
        [holding({ type: "null" }), [`${x}: a type of null, which has no Swift type here`]],
        [
          { Holder: { type: "object", properties: { "x~y": inline } } },
          ["#/components/schemas/Holder/properties/x~0y: an inline object: name it as a schema of its own"],
        ],
        // What is nearly Effect's number, a number or one of the strings it writes for those that aren't finite.
        [holding({ anyOf: [nonFinite, nothing] }), [`${x}/anyOf/0: an inline enum: name it as a schema of its own`]],
        [holding({ anyOf: [number, nonFinite, nothing] }), [`${x}: ${union}`]],
        [holding({ anyOf: [{ type: "number", enum: [1] }, nonFinite] }), [`${x}: ${union}`]],
        [
          holding({ anyOf: [number, { ...nonFinite, enum: ["NaN", "Infinity", "-Infinity", "Big"] }] }),
          [`${x}: ${union}`],
        ],
        [holding({ anyOf: [number, { ...nonFinite, enum: ["NaN", "Infinity", "Big"] }] }), [`${x}: ${union}`]],
        [holding({ anyOf: [number, { enum: nonFinite.enum }] }), [`${x}: ${union}`]],
        // Named schemas.
        [{ ...holding(ref("Broken")), Broken: null }, ["#/components/schemas/Broken: a schema must be an object"]],
        [
          { ...holding(ref("Level")), Level: { enum: ["low", "high"] } },
          ["#/components/schemas/Level: a schema with no type"],
        ],
        [
          { ...holding(ref("Loose")), Loose: { properties: { a: string } } },
          ["#/components/schemas/Loose: a schema with no type"],
        ],
        [
          { ...holding(ref("Only")), Only: constant("only") },
          ["#/components/schemas/Only: a constant here: only an object's property may be one"],
        ],
        [
          { ...holding(ref("Mixed")), Mixed: { type: "string", enum: ["a", 1] } },
          ["#/components/schemas/Mixed: an enum of other values than strings"],
        ],
        [
          { Level: { type: "string", enum: ["low", "high"], nullable: true, const: "low" } },
          ["#/components/schemas/Level: the keywords nullable, const, which no Swift type here holds"],
        ],
        [
          { Merged: { ...inline, allOf: [{}], not: {} } },
          ["#/components/schemas/Merged: the keywords allOf, not, which no Swift type here holds"],
        ],
        [
          { Tagged: { type: "object", properties: { _tag: constant("Tagged") } } },
          ["#/components/schemas/Tagged/properties/_tag: a constant that may be missing: make it required"],
        ],
        [
          { ...shapes, Shape: { anyOf: [ref("Circle"), ref("Square")], nullable: true, required: ["_tag"] } },
          ["#/components/schemas/Shape: the keywords nullable, required, which no Swift type here holds"],
        ],
        [
          { ...shapes, Shape: { anyOf: [ref("Circle"), ref("Square"), nothing] } },
          [
            "#/components/schemas/Shape/anyOf/2: a type of null, which has no Swift type here",
            "#/components/schemas/Shape/anyOf/2: a union's members must be named objects",
          ],
        ],
        [
          { ...shapes, Shape: { oneOf: [ref("Circle"), string] } },
          ["#/components/schemas/Shape/oneOf/1: a union's members must be named objects"],
        ],
        [
          { ...shapes, Shape: { anyOf: [ref("Circle"), inline] } },
          [
            "#/components/schemas/Shape/anyOf/1: an inline object: name it as a schema of its own",
            "#/components/schemas/Shape/anyOf/1: a union's members must be named objects",
          ],
        ],
        [
          { Shape: { anyOf: [string, { type: "integer" }] } },
          [
            "#/components/schemas/Shape/anyOf/0: a union's members must be named objects",
            "#/components/schemas/Shape/anyOf/1: a union's members must be named objects",
            "#/components/schemas/Shape: a union's members must share exactly one constant property, such as _tag",
          ],
        ],
        [
          {
            Circle: {
              type: "object",
              properties: { _tag: constant("Circle"), kind: constant("round") },
              required: ["_tag", "kind"],
            },
            Square: {
              type: "object",
              properties: { _tag: constant("Square"), kind: constant("square") },
              required: ["_tag", "kind"],
            },
            Shape: { anyOf: [ref("Circle"), ref("Square")] },
          },
          ["#/components/schemas/Shape: a union's members must share exactly one constant property, such as _tag"],
        ],
        [
          { ...shapes, Shape: { oneOf: [ref("Circle"), ref("Square")], discriminator: { propertyName: "kind" } } },
          ["#/components/schemas/Shape/discriminator: the discriminator must be _tag, the constant the members share"],
        ],
        [
          { ...shapes, Round: tagged("Circle"), Shape: { anyOf: [ref("Circle"), ref("Round")] } },
          [
            "#/components/schemas/Shape: a union's members must each have their own _tag",
            '#/components/schemas/Shape: "Circle" and "Circle" both make the case circle of the union',
          ],
        ],
        // Names.
        [
          { "1Note": inline },
          [
            "#/components/schemas/1Note: a schema's name must make a Swift type name: letters and digits, not a digit first",
          ],
        ],
        [
          {
            ItemOne: { ...inline, required: ["a", "b"] },
            item_one: { ...inline, required: ["a", "c"] },
            ItemTwo: { ...inline, required: ["a"] },
            item_two: { ...inline, required: ["a", "b"] },
            ItemThree: inline,
            item_three: { ...inline, description: "Another." },
            ItemFour: inline,
            item_four: { ...inline, properties: { a: null } },
          },
          [
            "#/components/schemas/item_one: another schema is also named ItemOne in Swift",
            "#/components/schemas/item_two: another schema is also named ItemTwo in Swift",
            "#/components/schemas/item_three: another schema is also named ItemThree in Swift",
            "#/components/schemas/item_four: another schema is also named ItemFour in Swift",
          ],
        ],
      ]
      for (const [schemas, problems] of rows) {
        assert.deepStrictEqual(yield* problemsOf(documentOf(schemas)), problems)
      }
    }),
  )

  it.effect("refuses each operation it doesn't write, saying where", () =>
    Effect.gen(function* () {
      const done = { "200": { description: "Done" } }
      const errors = "an error must be a named object with one constant property, such as _tag, or a union of them"
      const schemas = { NotFound: tagged("NotFound"), Plain: inline, Level: { type: "string", enum: ["low", "high"] } }
      const rows: ReadonlyArray<readonly [Readonly<Record<string, unknown>>, ReadonlyArray<string>]> = [
        [{ "/broken": null }, ["#/paths/~1broken: a path's operations must be an object"]],
        // Paths that would change what the API's address means: its host, its query or fragment, or
        // a step up; and one without its slash, or with a parameter no Swift name can hold.
        [
          Object.fromEntries(
            [
              "@other.example/stolen",
              "notes",
              "/notes?all=true",
              "/notes#top",
              "/notes/../admin",
              "/notes/./draft",
              "/notes/%2e%2e",
              "/a b",
              "/notes/{note-id}",
            ].map((route) => [route, { get: { operationId: "things.list", responses: done } }]),
          ),
          [
            "@other.example~1stolen",
            "notes",
            "~1notes?all=true",
            "~1notes#top",
            "~1notes~1..~1admin",
            "~1notes~1.~1draft",
            "~1notes~1%2e%2e",
            "~1a b",
            "~1notes~1{note-id}",
          ].map(
            (pointer) =>
              `#/paths/${pointer}: a path is / and segments of letters, digits, -, ., _, ~ and {parameters}, none of them . or ..`,
          ),
        ],
        [
          {
            "/things": {
              summary: "Things",
              description: "Every thing.",
              "x-internal": true,
              parameters: [],
              get: { operationId: "things.list", responses: done },
            },
          },
          [
            "#/paths/~1things/parameters: only GET, PUT, POST, PATCH and DELETE operations are supported, and parameters on each",
          ],
        ],
        [
          { "/things": { get: null, head: { operationId: "things.head", responses: done } } },
          [
            "#/paths/~1things/get: only GET, PUT, POST, PATCH and DELETE operations are supported, and parameters on each",
            "#/paths/~1things/head: only GET, PUT, POST, PATCH and DELETE operations are supported, and parameters on each",
          ],
        ],
        [
          {
            "/things": {
              get: { responses: done },
              put: { operationId: "things.2put", responses: done },
              post: { operationId: "things.list", responses: done },
              patch: { operationId: "acme.things.list", responses: done },
            },
          },
          [
            "#/paths/~1things/get/operationId: an operation needs an ID whose last part is a Swift name",
            "#/paths/~1things/put/operationId: an operation needs an ID whose last part is a Swift name",
            "#/paths/~1things/patch/operationId: another operation is already called list",
          ],
        ],
        [
          {
            "/things": {
              get: {
                operationId: "things.list",
                parameters: [null, { in: "query", schema: string }, { name: "", in: "query", schema: string }],
                responses: done,
              },
            },
          },
          [
            "#/paths/~1things/get/parameters/0: a parameter needs a name",
            "#/paths/~1things/get/parameters/1: a parameter needs a name",
            "#/paths/~1things/get/parameters/2: a parameter needs a name",
          ],
        ],
        [
          {
            "/things": {
              get: {
                operationId: "things.list",
                parameters: [
                  { name: "filter", in: "query", schema: inline },
                  { name: "ids", in: "query", schema: { type: "array", items: inline } },
                  { name: "tags", in: "query", schema: { type: "object", additionalProperties: inline } },
                  { name: "plain", in: "query", schema: ref("Plain") },
                  { name: "token", in: "cookie", schema: string },
                ],
                responses: done,
              },
            },
          },
          [
            "#/paths/~1things/get/parameters/0/schema: an inline object: name it as a schema of its own",
            "#/paths/~1things/get/parameters/1/schema/items: an inline object: name it as a schema of its own",
            "#/paths/~1things/get/parameters/2/schema/additionalProperties: an inline object: name it as a schema of its own",
            "#/paths/~1things/get/parameters/3: a parameter must be a string, a number, a boolean, a date, or an enum",
            "#/paths/~1things/get/parameters/4: only path and query parameters are supported",
          ],
        ],
        [
          {
            "/things/{id}": { get: { operationId: "things.read", responses: done } },
            "/others": {
              get: {
                operationId: "others.find",
                parameters: [{ name: "id", in: "path", required: true, schema: string }],
                responses: done,
              },
            },
          },
          [
            "#/paths/~1things~1{id}/get: the path's parameters and the operation's path parameters must be the same",
            "#/paths/~1others/get: the path's parameters and the operation's path parameters must be the same",
          ],
        ],
        [
          {
            "/things": {
              put: { operationId: "things.put", requestBody: { required: true }, responses: done },
              post: {
                operationId: "things.post",
                requestBody: {
                  required: true,
                  content: { "application/json": { schema: string }, "text/plain": { schema: string } },
                },
                responses: done,
              },
              patch: { operationId: "things.patch", requestBody: json(string), responses: done },
              delete: {
                operationId: "things.delete",
                requestBody: { required: true, ...json(inline) },
                responses: done,
              },
            },
          },
          [
            "#/paths/~1things/put/requestBody: a body must be JSON, application/json, only",
            "#/paths/~1things/post/requestBody: a body must be JSON, application/json, only",
            "#/paths/~1things/patch/requestBody: a body must be required: an optional one isn't supported",
            "#/paths/~1things/delete/requestBody/content/application~1json: an inline object: name it as a schema of its own",
          ],
        ],
        [
          {
            "/things": {
              get: {
                operationId: "things.get",
                responses: {
                  "200": {
                    description: "Two",
                    content: { "application/json": { schema: string }, "text/plain": { schema: string } },
                  },
                  "201": { description: "Created" },
                },
              },
              put: {
                operationId: "things.put",
                responses: { "200": { description: "Text", content: { "text/plain": { schema: string } } } },
              },
              post: { operationId: "things.post", responses: { "200": { description: "Inline", ...json(inline) } } },
              patch: {
                operationId: "things.patch",
                responses: {
                  ...done,
                  "301": { description: "Moved" },
                  "1200": { description: "Odd" },
                  "2000": { description: "Odd" },
                },
              },
              delete: {
                operationId: "things.delete",
                responses: { "404": { description: "Gone", ...json(ref("NotFound")) } },
              },
            },
          },
          [
            "#/paths/~1things/get/responses/200: a success must have a JSON body, application/json, or none",
            "#/paths/~1things/get/responses/201: an operation may answer with one success status only",
            "#/paths/~1things/put/responses/200: a success must have a JSON body, application/json, or none",
            "#/paths/~1things/post/responses/200/content/application~1json: an inline object: name it as a schema of its own",
            "#/paths/~1things/patch/responses/301: responses must have a 2xx, 4xx or 5xx status",
            "#/paths/~1things/patch/responses/1200: a response must have a status code: default and ranges such as 2XX aren't supported",
            "#/paths/~1things/patch/responses/2000: a response must have a status code: default and ranges such as 2XX aren't supported",
            "#/paths/~1things/delete/responses: an operation must answer with a 2xx status",
          ],
        ],
        [
          {
            "/things": {
              get: {
                operationId: "things.get",
                responses: {
                  ...done,
                  "400": { description: "Plain", ...json(ref("Plain")) },
                  "401": { description: "Text", ...json(string) },
                  "403": { description: "No schema", content: { "application/json": {} } },
                  "404": { description: "Mixed", ...json({ anyOf: [ref("NotFound"), string] }) },
                  "409": { description: "None", ...json({ anyOf: [] }) },
                  "422": { description: "Inline", ...json({ oneOf: [ref("NotFound"), inline] }) },
                },
              },
            },
          },
          [
            `#/paths/~1things/get/responses/400/content/application~1json: ${errors}`,
            `#/paths/~1things/get/responses/401/content/application~1json: ${errors}`,
            "#/paths/~1things/get/responses/403/content/application~1json: a schema must be an object",
            `#/paths/~1things/get/responses/403/content/application~1json: ${errors}`,
            `#/paths/~1things/get/responses/404/content/application~1json: ${errors}`,
            `#/paths/~1things/get/responses/409/content/application~1json: ${errors}`,
            "#/paths/~1things/get/responses/422/content/application~1json/oneOf/1: an inline object: name it as a schema of its own",
            `#/paths/~1things/get/responses/422/content/application~1json: ${errors}`,
          ],
        ],
      ]
      for (const [paths, problems] of rows) {
        assert.deepStrictEqual(yield* problemsOf(documentWith(paths, schemas)), problems)
      }
    }),
  )

  it.effect(
    "refuses every name the Swift file can't hold, of a property, a value, a case, a parameter or the client",
    () =>
      Effect.gen(function* () {
        const keys = ["", "a`b", "123", "+-", " note", "größe", "_", "Self"]
        const properties = Object.fromEntries(keys.map((key) => [key, string]))
        // Every error answers one call.
        const failing = (...names: ReadonlyArray<string>) =>
          Object.fromEntries(names.map((name, index) => [`${500 + index}`, { description: name, ...json(ref(name)) }]))
        const rows: ReadonlyArray<readonly [unknown, ReadonlyArray<string>]> = [
          // A constant's key is a key too: this one would end its line and write code.
          [
            documentOf({ Holder: tagged("held", 'kind\n#error("injected")\n//') }),
            [
              '#/components/schemas/Holder/properties/kind\n#error("injected")\n~1~1: a property\'s key no Swift name can hold',
            ],
          ],
          [
            documentOf({ Holder: { type: "object", properties } }),
            Object.keys(properties).map(
              (key) => `#/components/schemas/Holder/properties/${key}: a property's key no Swift name can hold`,
            ),
          ],
          [
            documentOf({ Values: { type: "string", enum: ["a`b", "_", "ok"] } }),
            [
              "#/components/schemas/Values: its value a`b can't be a Swift name",
              "#/components/schemas/Values: its value _ can't be a Swift name",
            ],
          ],
          [
            documentOf({
              Known: tagged("known", "kind"),
              Unknown: tagged("unknown", "kind"),
              Kinds: { anyOf: [ref("Known"), ref("Unknown")] },
            }),
            ['#/components/schemas/Kinds: "unknown" makes the case unknown, which the union takes for itself'],
          ],
          [
            documentWith(
              {
                "/things": {
                  get: {
                    operationId: "things.list",
                    responses: {
                      "200": { description: "Done" },
                      ...failing("Unreachable", "Unreadable", "Unwritable"),
                    },
                  },
                },
              },
              {
                Unreachable: tagged("Unreachable"),
                Unreadable: tagged("Unreadable"),
                Unwritable: tagged("Unwritable"),
              },
            ),
            [
              '#/components/schemas: "Unreachable" makes the case unreachable, which APIError takes for itself',
              '#/components/schemas: "Unreadable" makes the case unreadable, which APIError takes for itself',
              '#/components/schemas: "Unwritable" makes the case unwritable, which APIError takes for itself',
            ],
          ],
          [
            documentWith(
              {
                "/things": {
                  get: {
                    operationId: "things.list",
                    responses: { "200": { description: "Done" }, ...failing("Conflict", "Teapot") },
                  },
                },
              },
              { Conflict: tagged("Conflict"), Teapot: tagged("Teapot", "code") },
            ),
            [
              "#/components/schemas/Teapot: every error must be told apart by the same property; Teapot uses code, not _tag",
            ],
          ],
          [
            documentWith(
              {
                "/things": {
                  get: {
                    operationId: "things.list",
                    responses: { "200": { description: "Done" }, ...failing("Missing", "NotFound") },
                  },
                },
              },
              { Missing: tagged("NotFound"), NotFound: tagged("NotFound") },
            ),
            [
              "#/components/schemas/NotFound: another error is also named NotFound",
              '#/components/schemas: "NotFound" and "NotFound" both make the case notFound of APIError',
            ],
          ],
          [
            { ...documentOf({}), info: { title: "9 Lives" } },
            ["#/info/title: the client's name, 9LivesAPI, isn't a Swift type name"],
          ],
          [
            documentOf({ NotesAPI: inline }),
            [
              "#/components/schemas/NotesAPI: NotesAPI is a name the Swift client, Swift or Foundation takes; rename the schema",
            ],
          ],
          [
            documentWith(
              Object.fromEntries(
                [
                  ["/a", [{ name: "a`b", in: "query", schema: string }]],
                  ["/b", [{ name: "self", in: "query", schema: string }]],
                  ["/c", [{ name: "Self", in: "query", schema: string }]],
                  [
                    "/d/{id}",
                    [
                      { name: "id", in: "path", required: true, schema: string },
                      { name: "id", in: "query", schema: string },
                    ],
                  ],
                  [
                    "/e",
                    ["query items", "request body", "the answer"].map((name) => ({
                      name,
                      in: "query",
                      schema: string,
                    })),
                  ],
                ].map(([route, parameters], index) => [
                  route,
                  {
                    get: {
                      operationId: `things.${"abcde"[index]}`,
                      parameters,
                      responses: { "200": { description: "Done" } },
                    },
                  },
                ]),
              ),
            ),
            [
              "#/paths/~1a: the parameter a`b of a: no Swift name can hold it",
              "#/paths/~1b: the parameter self of b: no Swift name can hold it",
              "#/paths/~1c: the parameter Self of c: no Swift name can hold it",
              "#/paths/~1d~1{id}: the parameter id of d: another parameter has it",
              ...["query items", "request body", "the answer"].map(
                (name) =>
                  `#/paths/~1e: the parameter ${name} of e: the client takes it for its own (query items, request body, the answer)`,
              ),
            ],
          ],
          // Every problem at once: a document without a title still has its names checked.
          [
            { ...documentOf({ Task: inline }), info: {} },
            [
              "#/info/title: the document has no title, which names the client",
              "#/components/schemas/Task: Task is a name the Swift client, Swift or Foundation takes; rename the schema",
            ],
          ],
        ]
        for (const [document, problems] of rows) {
          assert.deepStrictEqual(yield* problemsOf(document), problems)
        }
      }),
  )

  it.effect("refuses every type that holds itself, through any others, other than in an array or a dictionary", () =>
    Effect.gen(function* () {
      const problems = yield* problemsOf(
        documentOf({
          Loop: objectOf({ next: ref("Loop"), label: string }),
          Leaf: tagged("Leaf"),
          Branch: objectOf({ _tag: constant("Branch"), child: ref("Node") }),
          Node: { anyOf: [ref("Leaf"), ref("Branch")] },
          A: objectOf({ b: ref("B") }),
          B: objectOf({ a: ref("A") }),
          // A type that holds a ring of others, and one that can't be read.
          Outer: objectOf({ ring: ref("Ring"), merged: ref("Merged") }),
          Ring: objectOf({ round: ref("Round") }),
          Round: objectOf({ ring: ref("Ring") }),
          Merged: { ...inline, allOf: [{}] },
        }),
      )
      assert.deepStrictEqual(problems, [
        "#/components/schemas/Merged: the keywords allOf, which no Swift type here holds",
        ...["A", "B", "Branch", "Loop", "Node", "Ring", "Round"].map(
          (name) =>
            `#/components/schemas/${name}: ${name} holds itself, other than in an array or a dictionary: Swift's structs can't`,
        ),
      ])
    }),
  )

  it.effect(
    "writes Swift's keywords as names in backticks, and refuses a type name Swift, Foundation or the client takes",
    () =>
      Effect.gen(function* () {
        // Swift's keywords, as The Swift Programming Language lists them for declarations, statements,
        // and expressions and types; Type and Protocol, which mean a metatype after a dot; and the
        // contextual keywords actor, any, async and some.
        const declarations = [
          "associatedtype",
          "borrowing",
          "class",
          "consuming",
          "deinit",
          "enum",
          "extension",
          "fileprivate",
          "func",
          "import",
          "init",
          "inout",
          "internal",
          "let",
          "nonisolated",
          "open",
          "operator",
          "precedencegroup",
          "private",
          "protocol",
          "public",
          "rethrows",
          "static",
          "struct",
          "subscript",
          "typealias",
          "var",
        ]
        const statements = [
          "break",
          "case",
          "catch",
          "continue",
          "default",
          "defer",
          "do",
          "else",
          "fallthrough",
          "for",
          "guard",
          "if",
          "in",
          "repeat",
          "return",
          "switch",
          "throw",
          "where",
          "while",
        ]
        const expressions = [
          "Any",
          "as",
          "await",
          "false",
          "is",
          "nil",
          "self",
          "Self",
          "super",
          "throws",
          "true",
          "try",
        ]
        const keywords = [
          ...declarations,
          ...statements,
          ...expressions,
          "Type",
          "Protocol",
          "actor",
          "any",
          "async",
          "some",
        ]
        const swift = yield* swiftClient(documentOf({ Words: { type: "string", enum: keywords } }))
        for (const keyword of keywords) {
          assert.include(swift, `    public static let \`${keyword}\` = Words(rawValue: "${keyword}")\n`)
        }
        // The client's own types, the modules it imports, the types of Swift and Foundation the file
        // names, and those an app uses most, which a type of the API would hide in the app's module.
        const own = ["APIError", "JSONValue", "Transport", "Swift", "Foundation", "FoundationNetworking"]
        const written = [
          "Bool",
          "CancellationError",
          "CharacterSet",
          "Codable",
          "CodingKey",
          "Data",
          "Date",
          "Decodable",
          "Decoder",
          "DecodingError",
          "Double",
          "Encodable",
          "Encoder",
          "Error",
          "Hashable",
          "HTTPURLResponse",
          "Int",
          "JSONDecoder",
          "JSONEncoder",
          "RawRepresentable",
          "Sendable",
          "String",
          "URL",
          "URLError",
          "URLRequest",
          "URLResponse",
          "URLSession",
        ]
        const common = [
          "Any",
          "AnyObject",
          "Array",
          "Character",
          "Dictionary",
          "EncodingError",
          "Equatable",
          "Float",
          "Identifiable",
          "Int8",
          "Int16",
          "Int32",
          "Int64",
          "Never",
          "Optional",
          "Result",
          "Set",
          "Task",
          "UInt",
          "UInt8",
          "UInt16",
          "UInt32",
          "UInt64",
          "UUID",
          "Void",
        ]
        const taken = [...own, ...written, ...common]
        assert.deepStrictEqual(
          yield* problemsOf(documentOf(Object.fromEntries(taken.map((name) => [name, inline])))),
          taken
            .toSorted()
            .map(
              (name) =>
                `#/components/schemas/${name}: ${name} is a name the Swift client, Swift or Foundation takes; rename the schema`,
            ),
        )
      }),
  )
})
