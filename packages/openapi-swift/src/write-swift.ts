import type { Api, Declaration, Operation, Parameter, Property, Struct, ValueType } from "./read-document.ts"
import { camelCase, docComment, oneLine, pascalCase, stringLiteral, swiftName } from "./swift-names.ts"

// Swift source from what the generator read; every name it writes was checked before. Names the
// generated code declares for itself are raw identifiers, such as `JSON keys`; a document's name
// that is one of them was refused (`swift-client.ts`). Where a document's names are in scope, in a
// struct's methods and an operation's, no type is written as an expression (`String.self`), which
// a property or parameter of that name would shadow; types are inferred instead.

// A name as Swift writes it. One that reaches here unchecked is this package's bug, which dies
// rather than writing the document's text as code.
const name = (text: string): string => {
  const written = swiftName(text)
  if (written === undefined) {
    throw new Error(`${JSON.stringify(text)} reached the Swift writer without being checked`)
  }
  return written
}

// A declaration's first line, `head(parameters)tail`, its parameters one to a line when it would be
// longer than 100 characters.
const signature = (indent: string, head: string, parameters: ReadonlyArray<string>, tail: string): string => {
  const line = `${indent}${head}(${parameters.join(", ")})${tail}`
  return line.length <= 100 || parameters.length === 0
    ? line
    : [`${indent}${head}(`, ...parameters.map((parameter) => `${indent}    ${parameter},`), `${indent})${tail}`].join(
        "\n",
      )
}

/** A value type as Swift writes it. */
export const swiftType = (type: ValueType): string => {
  switch (type._tag) {
    case "String":
    case "Date":
    case "Int":
    case "Double":
    case "Bool":
      return type._tag
    case "Json":
      return "JSONValue"
    case "Array":
      return `[${swiftType(type.of)}]`
    case "Dictionary":
      return `[String: ${swiftType(type.of)}]`
    case "Optional":
      return `${swiftType(type.of)}?`
    case "Named":
      return type.name
  }
}

/** The client's type: the document's title and `API`, `NotesAPI`. */
export const clientName = (api: Api): string => `${pascalCase(api.title)}API`

/** The case of a union or of `APIError` for a constant value: `circle`, `noteNotFound`. */
export const caseName = (value: string): string => camelCase(value)

// A property's Swift type: optional when it may be null or missing.
const propertyType = (property: Property): string => {
  const type = swiftType(property.type)
  return property.required || property.type._tag === "Optional" ? type : `${type}?`
}

const isOptional = (property: Property): boolean => !property.required || property.type._tag === "Optional"

// A required property is decoded, null included, as it is; one that may be missing as what it holds
// when present. Its type is inferred from the property's, never written as `Type.self`, which a
// property or parameter of the same name would shadow.
const decodeLine = (property: Property): string =>
  property.required
    ? `        self.${name(property.key)} = try container.\`value at\`(.${name(property.key)})`
    : `        self.${name(property.key)} = try container.\`value if present at\`(.${name(property.key)})`

// A required key is written even when nil, as null; one that may be missing is left out then.
const encodeLine = (property: Property): string =>
  property.required
    ? `        try container.encode(self.${name(property.key)}, forKey: .${name(property.key)})`
    : `        try container.encodeIfPresent(self.${name(property.key)}, forKey: .${name(property.key)})`

const writeStruct = (declaration: Struct): string => {
  const parameters = declaration.properties.map(
    (property) => `${name(property.key)}: ${propertyType(property)}${isOptional(property) ? " = nil" : ""}`,
  )
  const keys = [
    ...declaration.constants.map((constant) => constant.key),
    ...declaration.properties.map((property) => property.key),
  ]
  return [
    `public nonisolated struct ${declaration.name}: Codable, Hashable, Sendable {`,
    ...declaration.properties.map((property) => `    public let ${name(property.key)}: ${propertyType(property)}`),
    ...(declaration.properties.length > 0 ? [""] : []),
    signature("    ", "public init", parameters, " {"),
    ...declaration.properties.map((property) => `        self.${name(property.key)} = ${name(property.key)}`),
    "    }",
    "",
    "    private enum `JSON keys`: String, CodingKey {",
    ...keys.map((key) => `        case ${name(key)} = ${stringLiteral(key)}`),
    "    }",
    "",
    "    public init(from decoder: any Decoder) throws {",
    "        let container = try decoder.container(keyedBy: `JSON keys`.self)",
    ...declaration.constants.flatMap((constant) => [
      `        guard try container.\`value at\`(.${name(constant.key)}) as String == ${stringLiteral(constant.value)} else {`,
      `            throw container.\`corruption at\`(.${name(constant.key)}, ${stringLiteral(`${constant.key} isn't ${constant.value}.`)})`,
      "        }",
    ]),
    ...declaration.properties.map(decodeLine),
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        var container = encoder.container(keyedBy: `JSON keys`.self)",
    ...declaration.constants.map(
      (constant) => `        try container.encode(${stringLiteral(constant.value)}, forKey: .${name(constant.key)})`,
    ),
    ...declaration.properties.map(encodeLine),
    "    }",
    "}",
  ].join("\n")
}

const writeEnum = (declaration: Extract<Declaration, { readonly _tag: "Enum" }>): string =>
  [
    `/// One of a set of values; a value this client doesn't know, from a newer API, is kept as it is.`,
    `public nonisolated struct ${declaration.name}: RawRepresentable, Codable, Hashable, Sendable {`,
    "    public let rawValue: String",
    "",
    "    public init(rawValue: String) {",
    "        self.rawValue = rawValue",
    "    }",
    "",
    ...declaration.values.map(
      (value) => `    public static let ${name(value)} = ${declaration.name}(rawValue: ${stringLiteral(value)})`,
    ),
    "}",
  ].join("\n")

const writeUnion = (declaration: Extract<Declaration, { readonly _tag: "Union" }>): string =>
  [
    docComment(
      `One of several kinds, told apart by \`${declaration.discriminator}\`. A kind this client doesn't know, from a newer API, is \`unknown\`, with its name.`,
      "",
    ),
    `public nonisolated enum ${declaration.name}: Codable, Hashable, Sendable {`,
    ...declaration.cases.map((entry) => `    case ${name(caseName(entry.value))}(${entry.type})`),
    "    case unknown(String)",
    "",
    "    private enum `JSON keys`: String, CodingKey {",
    `        case kind = ${stringLiteral(declaration.discriminator)}`,
    "    }",
    "",
    "    public init(from decoder: any Decoder) throws {",
    "        let kind = try decoder.container(keyedBy: `JSON keys`.self).decode(String.self, forKey: .kind)",
    "        switch kind {",
    ...declaration.cases.map(
      (entry) =>
        `        case ${stringLiteral(entry.value)}: self = .${name(caseName(entry.value))}(try ${entry.type}(from: decoder))`,
    ),
    "        default: self = .unknown(kind)",
    "        }",
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        switch self {",
    ...declaration.cases.map(
      (entry) => `        case .${name(caseName(entry.value))}(let value): try value.encode(to: encoder)`,
    ),
    "        case .unknown(let kind):",
    "            var container = encoder.container(keyedBy: `JSON keys`.self)",
    "            try container.encode(kind, forKey: .kind)",
    "        }",
    "    }",
    "}",
  ].join("\n")

const writeDeclaration = (declaration: Declaration): string => {
  switch (declaration._tag) {
    case "Struct":
      return writeStruct(declaration)
    case "Enum":
      return writeEnum(declaration)
    case "Union":
      return writeUnion(declaration)
  }
}

const writeErrors = (api: Api): string =>
  [
    "/// Why a call failed: an error the API answered with, no answer at all, or one this client can't read.",
    "public nonisolated enum APIError: Error, Sendable {",
    ...api.errors.map((error) => `    case ${name(caseName(error.value))}(${error.name})`),
    "    /// The server didn't answer: no connection, a timeout, or a cancelled call.",
    "    case unreachable(URLError)",
    "    /// An answer this client can't read, such as a status or a shape from a newer API, and why.",
    "    case unreadable(status: Int, reason: String)",
    "    /// The request couldn't be written, such as a number that isn't finite in a query.",
    "    case unwritable(reason: String)",
    "}",
  ].join("\n")

// A parameter's value as the text a path or query holds.
const textOf = (parameter: Parameter): string => `Self.text(${name(parameter.name)})`

const writeOperation = (api: Api, operation: Operation): string => {
  const query = operation.queryParameters.toSorted((left, right) => Number(right.required) - Number(left.required))
  const parameters = [
    ...operation.pathParameters.map((parameter) => `${name(parameter.name)}: ${swiftType(parameter.type)}`),
    ...(operation.body === undefined ? [] : [`_ \`request body\`: ${swiftType(operation.body)}`]),
    ...query.map(
      (parameter) => `${name(parameter.name)}: ${swiftType(parameter.type)}${parameter.required ? "" : "? = nil"}`,
    ),
  ]
  const path = operation.pathParameters.reduce(
    (built, parameter) => built.replace(`{${parameter.name}}`, `\\(Self.segment(${textOf(parameter)}))`),
    stringLiteral(operation.path),
  )
  const errorCases = operation.errors.map((error) => {
    const value = api.errors.find((named) => named.name === error)?.value ?? error
    return `\`.${caseName(value)}\``
  })
  const documentation = [
    operation.description,
    errorCases.length === 0 ? undefined : `Fails with ${errorCases.join(", ")}, or as any call can.`,
  ].filter((paragraph) => paragraph !== undefined)
  const result = operation.result === undefined ? "" : ` -> ${swiftType(operation.result)}`
  const send = [
    stringLiteral(operation.method),
    path,
    ...(query.length === 0 ? [] : ["query: `query items`"]),
    ...(operation.body === undefined ? [] : ["body: try Self.encoded(`request body`)"]),
  ].join(", ")
  return [
    ...(documentation.length === 0 ? [] : [docComment(documentation.join("\n\n"), "    ")]),
    "    @concurrent",
    signature("    ", `public func ${name(operation.name)}`, parameters, ` async throws(APIError)${result} {`),
    ...(query.length === 0 ? [] : ["        var `query items`: [(String, String)] = []"]),
    ...query.map((parameter) =>
      parameter.required
        ? `        \`query items\`.append((${stringLiteral(parameter.name)}, ${textOf(parameter)}))`
        : `        if let ${name(parameter.name)} { \`query items\`.append((${stringLiteral(parameter.name)}, ${textOf(parameter)})) }`,
    ),
    operation.result === undefined
      ? `        _ = try await self.send(${send})`
      : `        let \`the answer\` = try await self.send(${send})`,
    ...(operation.result === undefined ? [] : ["        return try Self.decoded(from: `the answer`)"]),
    "    }",
  ].join("\n")
}

const writeClient = (api: Api): string => {
  const client = clientName(api)
  return [
    docComment(
      `A client of the ${oneLine(api.title)} API: one method per operation, each one request. Every method runs off the caller's actor, and fails with \`APIError\`.`,
      "",
    ),
    `public nonisolated struct ${client}: Sendable {`,
    "    /// Sends a request and returns its answer.",
    "    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)",
    "",
    "    /// Where the API is: each operation's path is added to it.",
    "    public let baseURL: URL",
    "    /// Sent as `Authorization: Bearer <token>` with every request, when set.",
    "    public let bearerToken: String?",
    "    /// Sent as every request's `User-Agent`, when set.",
    "    public let userAgent: String?",
    "    private let transport: Transport",
    "",
    "    /// A client of the API at `baseURL`, sending with `transport`, or `URLSession.shared` when it is nil.",
    "    public init(baseURL: URL, bearerToken: String? = nil, userAgent: String? = nil, transport: Transport? = nil) {",
    "        self.baseURL = baseURL",
    "        self.bearerToken = bearerToken",
    "        self.userAgent = userAgent",
    "        self.transport = transport ?? { request in try await URLSession.shared.data(for: request) }",
    "    }",
    ...api.operations.flatMap((operation) => ["", writeOperation(api, operation)]),
    "}",
  ].join("\n")
}

const writeFailure = (api: Api): ReadonlyArray<string> => [
  "    private static func failure(status: Int, data: Data) -> APIError {",
  ...(api.errorKey === undefined
    ? ['        .unreadable(status: status, reason: "The API names no errors.")']
    : [
        "        guard case .object(let fields)? = try? jsonDecoder().decode(JSONValue.self, from: data),",
        `            case .string(let named)? = fields[${stringLiteral(api.errorKey)}]`,
        "        else {",
        '            return .unreadable(status: status, reason: "The answer names no error.")',
        "        }",
        "        do {",
        "            switch named {",
        ...api.errors.map(
          (error) =>
            `            case ${stringLiteral(error.value)}: return .${name(caseName(error.value))}(try jsonDecoder().decode(${error.name}.self, from: data))`,
        ),
        '            default: return .unreadable(status: status, reason: "An error this client doesn\'t know: \\(named).")',
        "            }",
        "        } catch {",
        '            return .unreadable(status: status, reason: "\\(error)")',
        "        }",
      ]),
  "    }",
]

// How every method sends, reads, and writes: one request, JSON both ways, ISO 8601 dates, and
// numbers that aren't finite as Effect writes them, the strings "Infinity", "-Infinity" and "NaN".
const writeSupport = (api: Api): string =>
  [
    `nonisolated extension ${clientName(api)} {`,
    "    private func send(",
    "        _ method: String,",
    "        _ path: String,",
    "        query: [(String, String)] = [],",
    "        body: Data? = nil,",
    "    ) async throws(APIError) -> (data: Data, status: Int) {",
    "        var address = baseURL.absoluteString",
    '        if address.hasSuffix("/") { address.removeLast() }',
    "        address += path",
    "        if !query.isEmpty {",
    '            address += "?" + query.map { "\\(Self.escaped($0.0))=\\(Self.escaped($0.1))" }.joined(separator: "&")',
    "        }",
    "        guard let url = URL(string: address) else {",
    '            throw .unwritable(reason: "\\(address) isn\'t a URL.")',
    "        }",
    "        var request = URLRequest(url: url)",
    "        request.httpMethod = method",
    '        request.setValue("application/json", forHTTPHeaderField: "Accept")',
    '        if let bearerToken { request.setValue("Bearer \\(bearerToken)", forHTTPHeaderField: "Authorization") }',
    '        if let userAgent { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }',
    "        if let body {",
    "            request.httpBody = body",
    '            request.setValue("application/json", forHTTPHeaderField: "Content-Type")',
    "        }",
    "        let data: Data",
    "        let response: URLResponse",
    "        do {",
    "            (data, response) = try await transport(request)",
    "        } catch let error as URLError {",
    "            throw .unreachable(error)",
    "        } catch {",
    "            throw .unreachable(URLError(error is CancellationError ? .cancelled : .unknown))",
    "        }",
    "        let status = (response as? HTTPURLResponse)?.statusCode ?? 0",
    "        guard (200..<300).contains(status) else {",
    "            throw Self.failure(status: status, data: data)",
    "        }",
    "        return (data, status)",
    "    }",
    "",
    ...writeFailure(api),
    "",
    "    private static func decoded<Value: Decodable>(from answer: (data: Data, status: Int)) throws(APIError) -> Value {",
    "        do {",
    "            return try jsonDecoder().decode(Value.self, from: answer.data)",
    "        } catch {",
    '            throw .unreadable(status: answer.status, reason: "\\(error)")',
    "        }",
    "    }",
    "",
    "    private static func encoded(_ value: some Encodable) throws(APIError) -> Data {",
    "        do {",
    "            return try jsonEncoder().encode(value)",
    "        } catch {",
    '            throw .unwritable(reason: "\\(error)")',
    "        }",
    "    }",
    "",
    "    private static let instant = Date.ISO8601FormatStyle(includingFractionalSeconds: true)",
    "    private static let instantInSeconds = Date.ISO8601FormatStyle()",
    "",
    "    private static func jsonDecoder() -> JSONDecoder {",
    "        let decoder = JSONDecoder()",
    "        decoder.dateDecodingStrategy = .custom { decoder in",
    "            let container = try decoder.singleValueContainer()",
    "            let text = try container.decode(String.self)",
    "            if let date = (try? instant.parse(text)) ?? (try? instantInSeconds.parse(text)) { return date }",
    '            throw DecodingError.dataCorruptedError(in: container, debugDescription: "\\(text) isn\'t an ISO 8601 date-time.")',
    "        }",
    '        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")',
    "        return decoder",
    "    }",
    "",
    "    private static func jsonEncoder() -> JSONEncoder {",
    "        let encoder = JSONEncoder()",
    "        encoder.dateEncodingStrategy = .custom { date, encoder in",
    "            var container = encoder.singleValueContainer()",
    "            try container.encode(date.formatted(instant))",
    "        }",
    '        encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")',
    "        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]",
    "        return encoder",
    "    }",
    "",
    '    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")',
    "",
    "    private static func escaped(_ text: String) -> String {",
    "        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text",
    "    }",
    "",
    "    // A path parameter's value as a segment of its own: escaped, and refused when it is empty, `.`",
    "    // or `..`, which a URL reads as no segment or as a step up the path.",
    "    private static func segment(_ text: String) throws(APIError) -> String {",
    '        guard !text.isEmpty, text != ".", text != ".." else {',
    '            throw .unwritable(reason: "A path parameter of \\"\\(text)\\" isn\'t a segment of a path.")',
    "        }",
    "        return escaped(text)",
    "    }",
    "",
    "    private static func text(_ value: String) -> String { value }",
    "    private static func text(_ value: Date) -> String { value.formatted(instant) }",
    "    private static func text(_ value: Int) -> String { String(value) }",
    "    private static func text(_ value: Double) -> String { String(value) }",
    '    private static func text(_ value: Bool) -> String { value ? "true" : "false" }',
    "    private static func text<Value: RawRepresentable>(_ value: Value) -> String where Value.RawValue == String {",
    "        value.rawValue",
    "    }",
    "}",
  ].join("\n")

// How a struct reads its keys, its types inferred: in a struct, a property named `String` or after
// one of the API's types would shadow that type in `String.self`.
const keyedDecoding = [
  "nonisolated extension KeyedDecodingContainer {",
  "    fileprivate func `value at`<Value: Decodable>(_ key: Key) throws -> Value {",
  "        try decode(Value.self, forKey: key)",
  "    }",
  "",
  "    fileprivate func `value if present at`<Value: Decodable>(_ key: Key) throws -> Value? {",
  "        try decodeIfPresent(Value.self, forKey: key)",
  "    }",
  "",
  "    fileprivate func `corruption at`(_ key: Key, _ description: String) -> DecodingError {",
  "        .dataCorruptedError(forKey: key, in: self, debugDescription: description)",
  "    }",
  "}",
].join("\n")

const jsonValue = [
  "/// A value of any JSON shape, as the API sends free-form data; numbers are doubles.",
  "public nonisolated enum JSONValue: Codable, Hashable, Sendable {",
  "    case null",
  "    case bool(Bool)",
  "    case number(Double)",
  "    case string(String)",
  "    case array([JSONValue])",
  "    case object([String: JSONValue])",
  "",
  "    public init(from decoder: any Decoder) throws {",
  "        let container = try decoder.singleValueContainer()",
  "        if container.decodeNil() {",
  "            self = .null",
  "        } else if let value = try? container.decode(Bool.self) {",
  "            self = .bool(value)",
  "        } else if let value = try? container.decode(String.self) {",
  "            self = .string(value)",
  "        } else if let value = try? container.decode(Double.self) {",
  "            self = .number(value)",
  "        } else if let value = try? container.decode([JSONValue].self) {",
  "            self = .array(value)",
  "        } else {",
  "            self = .object(try container.decode([String: JSONValue].self))",
  "        }",
  "    }",
  "",
  "    public func encode(to encoder: any Encoder) throws {",
  "        var container = encoder.singleValueContainer()",
  "        switch self {",
  "        case .null: try container.encodeNil()",
  "        case .bool(let value): try container.encode(value)",
  "        case .number(let value): try container.encode(value)",
  "        case .string(let value): try container.encode(value)",
  "        case .array(let value): try container.encode(value)",
  "        case .object(let value): try container.encode(value)",
  "        }",
  "    }",
  "}",
].join("\n")

/** The whole Swift file for `api`. */
export const writeSwift = (api: Api): string =>
  [
    [
      `// The ${oneLine(api.title)} API's Swift client, written by @bagatka/openapi-swift from its OpenAPI`,
      "// document. Don't edit it: write it again from the document.",
      "",
      "import Foundation",
      "#if canImport(FoundationNetworking)",
      "import FoundationNetworking",
      "#endif",
    ].join("\n"),
    writeClient(api),
    writeErrors(api),
    ...api.declarations.map(writeDeclaration),
    jsonValue,
    keyedDecoding,
    writeSupport(api),
  ].join("\n\n") + "\n"
