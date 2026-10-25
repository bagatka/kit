// The Odd // title: injected code API's Swift client, written by @bagatka/openapi-swift from its OpenAPI
// document. Don't edit it: write it again from the document.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A client of the Odd // title: injected code API: one method per operation, each one request.
/// Every method runs off the caller's actor, and fails with `APIError`.
public nonisolated struct OddTitleInjectedCodeAPI: Sendable {
    /// Sends a request and returns its answer.
    public typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

    /// Where the API is: each operation's path is added to it.
    public let baseURL: URL
    /// Sent as `Authorization: Bearer <token>` with every request, when set.
    public let bearerToken: String?
    /// Sent as every request's `User-Agent`, when set.
    public let userAgent: String?
    private let transport: Transport

    /// A client of the API at `baseURL`, sending with `transport`, or `URLSession.shared` when it is nil.
    public init(baseURL: URL, bearerToken: String? = nil, userAgent: String? = nil, transport: Transport? = nil) {
        self.baseURL = baseURL
        self.bearerToken = bearerToken
        self.userAgent = userAgent
        self.transport = transport ?? { request in try await URLSession.shared.data(for: request) }
    }

    /// Reads an answer. // injected: a line of code
    ///
    /// */ not the end of anything either
    ///
    /// Fails with `.goneForGood`, or as any call can.
    @concurrent
    public func getAnswer(
        id: String,
        query: String,
        body: Int? = nil,
        `page[size]`: Double? = nil,
        `default`: Kind? = nil,
        at: Date? = nil,
        Answer: String? = nil,
    ) async throws(APIError) -> Answer {
        var `query items`: [(String, String)] = []
        `query items`.append(("query", Self.text(query)))
        if let body { `query items`.append(("body", Self.text(body))) }
        if let `page[size]` { `query items`.append(("page[size]", Self.text(`page[size]`))) }
        if let `default` { `query items`.append(("default", Self.text(`default`))) }
        if let at { `query items`.append(("at", Self.text(at))) }
        if let Answer { `query items`.append(("Answer", Self.text(Answer))) }
        let `the answer` = try await self.send("GET", "/answers/\(Self.segment(Self.text(id)))", query: `query items`)
        return try Self.decoded(from: `the answer`)
    }

    @concurrent
    public func putAnswer(id: String, _ `request body`: [Event]) async throws(APIError) {
        _ = try await self.send("PUT", "/answers/\(Self.segment(Self.text(id)))", body: try Self.encoded(`request body`))
    }

    @concurrent
    public func `repeat`(id: String) async throws(APIError) {
        _ = try await self.send("POST", "/answers/\(Self.segment(Self.text(id)))/again")
    }
}

/// Why a call failed: an error the API answered with, no answer at all, or one this client can't read.
public nonisolated enum APIError: Error, Sendable {
    case goneForGood(Gone)
    /// The server didn't answer: no connection, a timeout, or a cancelled call.
    case unreachable(URLError)
    /// An answer this client can't read, such as a status or a shape from a newer API, and why.
    case unreadable(status: Int, reason: String)
    /// The request couldn't be written, such as a number that isn't finite in a query.
    case unwritable(reason: String)
}

public nonisolated struct Answer: Codable, Hashable, Sendable {
    public let `default`: String
    public let container: String
    public let encoder: String
    public let decoder: Int?
    public let `1m`: Int
    public let `a b`: String?
    public let `kebab-key`: [Kind]?
    public let type: Kind
    public let `init`: Bool?
    public let tree: Tree
    public let String: String
    public let Kind: Kind
    public let Date: Date
    public let JSONValue: JSONValue
    public let Int: Int?

    public init(
        `default`: String,
        container: String,
        encoder: String,
        decoder: Int? = nil,
        `1m`: Int,
        `a b`: String? = nil,
        `kebab-key`: [Kind]? = nil,
        type: Kind,
        `init`: Bool? = nil,
        tree: Tree,
        String: String,
        Kind: Kind,
        Date: Date,
        JSONValue: JSONValue,
        Int: Int? = nil,
    ) {
        self.`default` = `default`
        self.container = container
        self.encoder = encoder
        self.decoder = decoder
        self.`1m` = `1m`
        self.`a b` = `a b`
        self.`kebab-key` = `kebab-key`
        self.type = type
        self.`init` = `init`
        self.tree = tree
        self.String = String
        self.Kind = Kind
        self.Date = Date
        self.JSONValue = JSONValue
        self.Int = Int
    }

    private enum `JSON keys`: String, CodingKey {
        case `default` = "default"
        case container = "container"
        case encoder = "encoder"
        case decoder = "decoder"
        case `1m` = "1m"
        case `a b` = "a b"
        case `kebab-key` = "kebab-key"
        case type = "type"
        case `init` = "init"
        case tree = "tree"
        case String = "String"
        case Kind = "Kind"
        case Date = "Date"
        case JSONValue = "JSONValue"
        case Int = "Int"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        self.`default` = try container.`value at`(.`default`)
        self.container = try container.`value at`(.container)
        self.encoder = try container.`value at`(.encoder)
        self.decoder = try container.`value if present at`(.decoder)
        self.`1m` = try container.`value at`(.`1m`)
        self.`a b` = try container.`value at`(.`a b`)
        self.`kebab-key` = try container.`value if present at`(.`kebab-key`)
        self.type = try container.`value at`(.type)
        self.`init` = try container.`value if present at`(.`init`)
        self.tree = try container.`value at`(.tree)
        self.String = try container.`value at`(.String)
        self.Kind = try container.`value at`(.Kind)
        self.Date = try container.`value at`(.Date)
        self.JSONValue = try container.`value at`(.JSONValue)
        self.Int = try container.`value if present at`(.Int)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode(self.`default`, forKey: .`default`)
        try container.encode(self.container, forKey: .container)
        try container.encode(self.encoder, forKey: .encoder)
        try container.encodeIfPresent(self.decoder, forKey: .decoder)
        try container.encode(self.`1m`, forKey: .`1m`)
        try container.encode(self.`a b`, forKey: .`a b`)
        try container.encodeIfPresent(self.`kebab-key`, forKey: .`kebab-key`)
        try container.encode(self.type, forKey: .type)
        try container.encodeIfPresent(self.`init`, forKey: .`init`)
        try container.encode(self.tree, forKey: .tree)
        try container.encode(self.String, forKey: .String)
        try container.encode(self.Kind, forKey: .Kind)
        try container.encode(self.Date, forKey: .Date)
        try container.encode(self.JSONValue, forKey: .JSONValue)
        try container.encodeIfPresent(self.Int, forKey: .Int)
    }
}

public nonisolated struct Created: Codable, Hashable, Sendable {
    public let at: Date
    public let String: String?
    public let DecodingError: String?

    public init(at: Date, String: String? = nil, DecodingError: String? = nil) {
        self.at = at
        self.String = String
        self.DecodingError = DecodingError
    }

    private enum `JSON keys`: String, CodingKey {
        case kind = "kind"
        case at = "at"
        case String = "String"
        case DecodingError = "DecodingError"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(.kind) as String == "note.created \"quoted\" \\ back" else {
            throw container.`corruption at`(.kind, "kind isn't note.created \"quoted\" \\ back.")
        }
        self.at = try container.`value at`(.at)
        self.String = try container.`value if present at`(.String)
        self.DecodingError = try container.`value if present at`(.DecodingError)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("note.created \"quoted\" \\ back", forKey: .kind)
        try container.encode(self.at, forKey: .at)
        try container.encodeIfPresent(self.String, forKey: .String)
        try container.encodeIfPresent(self.DecodingError, forKey: .DecodingError)
    }
}

public nonisolated struct Deleted: Codable, Hashable, Sendable {
    public init() {
    }

    private enum `JSON keys`: String, CodingKey {
        case kind = "kind"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(.kind) as String == "note-deleted" else {
            throw container.`corruption at`(.kind, "kind isn't note-deleted.")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("note-deleted", forKey: .kind)
    }
}

/// One of several kinds, told apart by `kind`. A kind this client doesn't know, from a newer API,
/// is `unknown`, with its name.
public nonisolated enum Event: Codable, Hashable, Sendable {
    case noteCreatedQuotedBack(Created)
    case noteDeleted(Deleted)
    case unknown(String)

    private enum `JSON keys`: String, CodingKey {
        case kind = "kind"
    }

    public init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: `JSON keys`.self).decode(String.self, forKey: .kind)
        switch kind {
        case "note.created \"quoted\" \\ back": self = .noteCreatedQuotedBack(try Created(from: decoder))
        case "note-deleted": self = .noteDeleted(try Deleted(from: decoder))
        default: self = .unknown(kind)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .noteCreatedQuotedBack(let value): try value.encode(to: encoder)
        case .noteDeleted(let value): try value.encode(to: encoder)
        case .unknown(let kind):
            var container = encoder.container(keyedBy: `JSON keys`.self)
            try container.encode(kind, forKey: .kind)
        }
    }
}

public nonisolated struct Gone: Codable, Hashable, Sendable {
    public init() {
    }

    private enum `JSON keys`: String, CodingKey {
        case code = "code"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(.code) as String == "gone\u{a}for good" else {
            throw container.`corruption at`(.code, "code isn't gone\u{a}for good.")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("gone\u{a}for good", forKey: .code)
    }
}

public nonisolated struct Hashed: Codable, Hashable, Sendable {
    public init() {
    }

    private enum `JSON keys`: String, CodingKey {
        case hashValue = "hashValue"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(.hashValue) as String == "hashed" else {
            throw container.`corruption at`(.hashValue, "hashValue isn't hashed.")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("hashed", forKey: .hashValue)
    }
}

/// One of a set of values; a value this client doesn't know, from a newer API, is kept as it is.
public nonisolated struct Kind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let `1m` = Kind(rawValue: "1m")
    public static let `init` = Kind(rawValue: "init")
    public static let `a-b` = Kind(rawValue: "a-b")
    public static let ok = Kind(rawValue: "ok")
    public static let `self` = Kind(rawValue: "self")
}

public nonisolated struct Tree: Codable, Hashable, Sendable {
    public let label: String
    public let children: [Tree]

    public init(label: String, children: [Tree]) {
        self.label = label
        self.children = children
    }

    private enum `JSON keys`: String, CodingKey {
        case label = "label"
        case children = "children"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        self.label = try container.`value at`(.label)
        self.children = try container.`value at`(.children)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode(self.label, forKey: .label)
        try container.encode(self.children, forKey: .children)
    }
}

/// A value of any JSON shape, as the API sends free-form data; numbers are doubles.
public nonisolated enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

nonisolated extension KeyedDecodingContainer {
    fileprivate func `value at`<Value: Decodable>(_ key: Key) throws -> Value {
        try decode(Value.self, forKey: key)
    }

    fileprivate func `value if present at`<Value: Decodable>(_ key: Key) throws -> Value? {
        try decodeIfPresent(Value.self, forKey: key)
    }

    fileprivate func `corruption at`(_ key: Key, _ description: String) -> DecodingError {
        .dataCorruptedError(forKey: key, in: self, debugDescription: description)
    }
}

nonisolated extension OddTitleInjectedCodeAPI {
    private func send(
        _ method: String,
        _ path: String,
        query: [(String, String)] = [],
        body: Data? = nil,
    ) async throws(APIError) -> (data: Data, status: Int) {
        var address = baseURL.absoluteString
        if address.hasSuffix("/") { address.removeLast() }
        address += path
        if !query.isEmpty {
            address += "?" + query.map { "\(Self.escaped($0.0))=\(Self.escaped($0.1))" }.joined(separator: "&")
        }
        guard let url = URL(string: address) else {
            throw .unwritable(reason: "\(address) isn't a URL.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bearerToken { request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization") }
        if let userAgent { request.setValue(userAgent, forHTTPHeaderField: "User-Agent") }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await transport(request)
        } catch let error as URLError {
            throw .unreachable(error)
        } catch {
            throw .unreachable(URLError(error is CancellationError ? .cancelled : .unknown))
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw Self.failure(status: status, data: data)
        }
        return (data, status)
    }

    private static func failure(status: Int, data: Data) -> APIError {
        guard case .object(let fields)? = try? jsonDecoder().decode(JSONValue.self, from: data),
            case .string(let named)? = fields["code"]
        else {
            return .unreadable(status: status, reason: "The answer names no error.")
        }
        do {
            switch named {
            case "gone\u{a}for good": return .goneForGood(try jsonDecoder().decode(Gone.self, from: data))
            default: return .unreadable(status: status, reason: "An error this client doesn't know: \(named).")
            }
        } catch {
            return .unreadable(status: status, reason: "\(error)")
        }
    }

    private static func decoded<Value: Decodable>(from answer: (data: Data, status: Int)) throws(APIError) -> Value {
        do {
            return try jsonDecoder().decode(Value.self, from: answer.data)
        } catch {
            throw .unreadable(status: answer.status, reason: "\(error)")
        }
    }

    private static func encoded(_ value: some Encodable) throws(APIError) -> Data {
        do {
            return try jsonEncoder().encode(value)
        } catch {
            throw .unwritable(reason: "\(error)")
        }
    }

    private static let instant = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let instantInSeconds = Date.ISO8601FormatStyle()

    private static func jsonDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            if let date = (try? instant.parse(text)) ?? (try? instantInSeconds.parse(text)) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "\(text) isn't an ISO 8601 date-time.")
        }
        decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        return decoder
    }

    private static func jsonEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(date.formatted(instant))
        }
        encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    private static func escaped(_ text: String) -> String {
        text.addingPercentEncoding(withAllowedCharacters: unreserved) ?? text
    }

    // A path parameter's value as a segment of its own: escaped, and refused when it is empty, `.`
    // or `..`, which a URL reads as no segment or as a step up the path.
    private static func segment(_ text: String) throws(APIError) -> String {
        guard !text.isEmpty, text != ".", text != ".." else {
            throw .unwritable(reason: "A path parameter of \"\(text)\" isn't a segment of a path.")
        }
        return escaped(text)
    }

    private static func text(_ value: String) -> String { value }
    private static func text(_ value: Date) -> String { value.formatted(instant) }
    private static func text(_ value: Int) -> String { String(value) }
    private static func text(_ value: Double) -> String { String(value) }
    private static func text(_ value: Bool) -> String { value ? "true" : "false" }
    private static func text<Value: RawRepresentable>(_ value: Value) -> String where Value.RawValue == String {
        value.rawValue
    }
}
