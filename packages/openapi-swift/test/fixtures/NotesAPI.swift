// The Notes API's Swift client, written by @bagatka/openapi-swift from its OpenAPI
// document. Don't edit it: write it again from the document.

import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A client of the Notes API: one method per operation, each one request. Every method runs off the
/// caller's actor, and fails with `APIError`.
public nonisolated struct NotesAPI: Sendable {
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

    @concurrent
    public func listNotes(
        since: String? = nil,
        limit: String? = nil,
        color: Color? = nil,
        q: String? = nil,
    ) async throws(APIError) -> [Note] {
        var `query items`: [(String, String)] = []
        if let since { `query items`.append(("since", Self.text(since))) }
        if let limit { `query items`.append(("limit", Self.text(limit))) }
        if let color { `query items`.append(("color", Self.text(color))) }
        if let q { `query items`.append(("q", Self.text(q))) }
        let `the answer` = try await self.send("GET", "/notes", query: `query items`)
        return try Self.decoded(from: `the answer`)
    }

    /// Fails with `.badRequest`, `.notAllowed`, or as any call can.
    @concurrent
    public func createNote(_ `request body`: NewNote) async throws(APIError) -> Note {
        let `the answer` = try await self.send("POST", "/notes", body: try Self.encoded(`request body`))
        return try Self.decoded(from: `the answer`)
    }

    /// Fails with `.noteNotFound`, or as any call can.
    @concurrent
    public func getNote(id: String) async throws(APIError) -> Note {
        let `the answer` = try await self.send("GET", "/notes/\(Self.segment(Self.text(id)))")
        return try Self.decoded(from: `the answer`)
    }

    /// Fails with `.notAllowed`, `.noteNotFound`, or as any call can.
    @concurrent
    public func deleteNote(id: String) async throws(APIError) {
        _ = try await self.send("DELETE", "/notes/\(Self.segment(Self.text(id)))")
    }
}

/// Why a call failed: an error the API answered with, no answer at all, or one this client can't read.
public nonisolated enum APIError: Error, Sendable {
    case badRequest(EffectHttpApiErrorBadRequest)
    case notAllowed(NotAllowed)
    case noteNotFound(NoteNotFound)
    /// The server didn't answer: no connection, a timeout, or a cancelled call.
    case unreachable(URLError)
    /// An answer this client can't read, such as a status or a shape from a newer API, and why.
    case unreadable(status: Int, reason: String)
    /// The request couldn't be written, such as a number that isn't finite in a query.
    case unwritable(reason: String)
}

public nonisolated struct Circle: Codable, Hashable, Sendable {
    public let radius: Double

    public init(radius: Double) {
        self.radius = radius
    }

    private enum `JSON keys`: String, CodingKey {
        case _tag = "_tag"
        case radius = "radius"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(._tag) as String == "Circle" else {
            throw container.`corruption at`(._tag, "_tag isn't Circle.")
        }
        self.radius = try container.`value at`(.radius)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("Circle", forKey: ._tag)
        try container.encode(self.radius, forKey: .radius)
    }
}

/// One of a set of values; a value this client doesn't know, from a newer API, is kept as it is.
public nonisolated struct Color: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public static let red = Color(rawValue: "red")
    public static let green = Color(rawValue: "green")
    public static let `1m` = Color(rawValue: "1m")
}

public nonisolated struct EffectHttpApiErrorBadRequest: Codable, Hashable, Sendable {
    public init() {
    }

    private enum `JSON keys`: String, CodingKey {
        case _tag = "_tag"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(._tag) as String == "BadRequest" else {
            throw container.`corruption at`(._tag, "_tag isn't BadRequest.")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("BadRequest", forKey: ._tag)
    }
}

public nonisolated struct NewNote: Codable, Hashable, Sendable {
    public let title: String
    public let body: String?
    public let color: Color
    public let shape: Shape
    public let stamp: Circle

    public init(title: String, body: String? = nil, color: Color, shape: Shape, stamp: Circle) {
        self.title = title
        self.body = body
        self.color = color
        self.shape = shape
        self.stamp = stamp
    }

    private enum `JSON keys`: String, CodingKey {
        case title = "title"
        case body = "body"
        case color = "color"
        case shape = "shape"
        case stamp = "stamp"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        self.title = try container.`value at`(.title)
        self.body = try container.`value if present at`(.body)
        self.color = try container.`value at`(.color)
        self.shape = try container.`value at`(.shape)
        self.stamp = try container.`value at`(.stamp)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode(self.title, forKey: .title)
        try container.encodeIfPresent(self.body, forKey: .body)
        try container.encode(self.color, forKey: .color)
        try container.encode(self.shape, forKey: .shape)
        try container.encode(self.stamp, forKey: .stamp)
    }
}

public nonisolated struct NotAllowed: Codable, Hashable, Sendable {
    public let reason: String

    public init(reason: String) {
        self.reason = reason
    }

    private enum `JSON keys`: String, CodingKey {
        case _tag = "_tag"
        case reason = "reason"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(._tag) as String == "NotAllowed" else {
            throw container.`corruption at`(._tag, "_tag isn't NotAllowed.")
        }
        self.reason = try container.`value at`(.reason)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("NotAllowed", forKey: ._tag)
        try container.encode(self.reason, forKey: .reason)
    }
}

public nonisolated struct Note: Codable, Hashable, Sendable {
    public let id: String
    public let title: String
    public let body: String?
    public let pinned: Bool
    public let color: Color
    public let tags: [String]
    public let createdAt: String
    public let views: Int
    public let score: Double
    public let extra: [String: Double]
    public let meta: JSONValue?
    public let archivedAt: String?
    public let rank: Int?

    public init(
        id: String,
        title: String,
        body: String? = nil,
        pinned: Bool,
        color: Color,
        tags: [String],
        createdAt: String,
        views: Int,
        score: Double,
        extra: [String: Double],
        meta: JSONValue? = nil,
        archivedAt: String? = nil,
        rank: Int? = nil,
    ) {
        self.id = id
        self.title = title
        self.body = body
        self.pinned = pinned
        self.color = color
        self.tags = tags
        self.createdAt = createdAt
        self.views = views
        self.score = score
        self.extra = extra
        self.meta = meta
        self.archivedAt = archivedAt
        self.rank = rank
    }

    private enum `JSON keys`: String, CodingKey {
        case id = "id"
        case title = "title"
        case body = "body"
        case pinned = "pinned"
        case color = "color"
        case tags = "tags"
        case createdAt = "createdAt"
        case views = "views"
        case score = "score"
        case extra = "extra"
        case meta = "meta"
        case archivedAt = "archivedAt"
        case rank = "rank"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        self.id = try container.`value at`(.id)
        self.title = try container.`value at`(.title)
        self.body = try container.`value at`(.body)
        self.pinned = try container.`value at`(.pinned)
        self.color = try container.`value at`(.color)
        self.tags = try container.`value at`(.tags)
        self.createdAt = try container.`value at`(.createdAt)
        self.views = try container.`value at`(.views)
        self.score = try container.`value at`(.score)
        self.extra = try container.`value at`(.extra)
        self.meta = try container.`value if present at`(.meta)
        self.archivedAt = try container.`value if present at`(.archivedAt)
        self.rank = try container.`value if present at`(.rank)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode(self.id, forKey: .id)
        try container.encode(self.title, forKey: .title)
        try container.encode(self.body, forKey: .body)
        try container.encode(self.pinned, forKey: .pinned)
        try container.encode(self.color, forKey: .color)
        try container.encode(self.tags, forKey: .tags)
        try container.encode(self.createdAt, forKey: .createdAt)
        try container.encode(self.views, forKey: .views)
        try container.encode(self.score, forKey: .score)
        try container.encode(self.extra, forKey: .extra)
        try container.encodeIfPresent(self.meta, forKey: .meta)
        try container.encodeIfPresent(self.archivedAt, forKey: .archivedAt)
        try container.encodeIfPresent(self.rank, forKey: .rank)
    }
}

public nonisolated struct NoteNotFound: Codable, Hashable, Sendable {
    public let id: String

    public init(id: String) {
        self.id = id
    }

    private enum `JSON keys`: String, CodingKey {
        case _tag = "_tag"
        case id = "id"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(._tag) as String == "NoteNotFound" else {
            throw container.`corruption at`(._tag, "_tag isn't NoteNotFound.")
        }
        self.id = try container.`value at`(.id)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("NoteNotFound", forKey: ._tag)
        try container.encode(self.id, forKey: .id)
    }
}

/// One of several kinds, told apart by `_tag`. A kind this client doesn't know, from a newer API,
/// is `unknown`, with its name.
public nonisolated enum Shape: Codable, Hashable, Sendable {
    case circle(Circle)
    case square(Square)
    case unknown(String)

    private enum `JSON keys`: String, CodingKey {
        case kind = "_tag"
    }

    public init(from decoder: any Decoder) throws {
        let kind = try decoder.container(keyedBy: `JSON keys`.self).decode(String.self, forKey: .kind)
        switch kind {
        case "Circle": self = .circle(try Circle(from: decoder))
        case "Square": self = .square(try Square(from: decoder))
        default: self = .unknown(kind)
        }
    }

    public func encode(to encoder: any Encoder) throws {
        switch self {
        case .circle(let value): try value.encode(to: encoder)
        case .square(let value): try value.encode(to: encoder)
        case .unknown(let kind):
            var container = encoder.container(keyedBy: `JSON keys`.self)
            try container.encode(kind, forKey: .kind)
        }
    }
}

public nonisolated struct Square: Codable, Hashable, Sendable {
    public let side: Double

    public init(side: Double) {
        self.side = side
    }

    private enum `JSON keys`: String, CodingKey {
        case _tag = "_tag"
        case side = "side"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: `JSON keys`.self)
        guard try container.`value at`(._tag) as String == "Square" else {
            throw container.`corruption at`(._tag, "_tag isn't Square.")
        }
        self.side = try container.`value at`(.side)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: `JSON keys`.self)
        try container.encode("Square", forKey: ._tag)
        try container.encode(self.side, forKey: .side)
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

nonisolated extension NotesAPI {
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
            case .string(let named)? = fields["_tag"]
        else {
            return .unreadable(status: status, reason: "The answer names no error.")
        }
        do {
            switch named {
            case "BadRequest": return .badRequest(try jsonDecoder().decode(EffectHttpApiErrorBadRequest.self, from: data))
            case "NotAllowed": return .notAllowed(try jsonDecoder().decode(NotAllowed.self, from: data))
            case "NoteNotFound": return .noteNotFound(try jsonDecoder().decode(NoteNotFound.self, from: data))
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
