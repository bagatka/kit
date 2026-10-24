// Calls the Notes API's generated client, NotesAPI.swift, through a transport that answers with what
// Effect's server sends (wire.json), and checks what the client sends and reads: requests, bodies,
// results, and errors, as JSON, against Effect's. `bun run check:swift` compiles and runs it:
//
//   round-trip <path to wire.json>
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// The answers to send, in turn, and the requests the client made.
actor Exchange {
    private var answers: [(status: Int, body: Data)] = []
    private(set) var requests: [URLRequest] = []

    func answer(with status: Int, _ body: Data = Data()) {
        answers.append((status, body))
    }

    func take(_ request: URLRequest) throws -> (Data, URLResponse) {
        requests.append(request)
        guard !answers.isEmpty else { throw URLError(.notConnectedToInternet) }
        let (status, body) = answers.removeFirst()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil)!
        return (body, response)
    }
}

// JSON as values, so two texts of the same JSON compare equal, numbers as doubles.
func json(_ data: Data) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: data)
}

// What the client encodes a value as, with the settings it sends with.
func encoded(_ value: some Encodable) throws -> Data {
    let encoder = JSONEncoder()
    encoder.nonConformingFloatEncodingStrategy = .convertToString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    return try encoder.encode(value)
}

func decoded<Value: Decodable>(_ type: Value.Type, _ data: Data) throws -> Value {
    let decoder = JSONDecoder()
    decoder.nonConformingFloatDecodingStrategy = .convertFromString(positiveInfinity: "Infinity", negativeInfinity: "-Infinity", nan: "NaN")
    return try decoder.decode(type, from: data)
}

@main
struct RoundTrip {
    static func main() async throws {
        let wireText = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        guard case .object(let wire) = try json(wireText) else { fatalError("wire.json isn't an object") }
        func part(_ name: String) throws -> Data { try encoded(wire[name] ?? .null) }

        var failures: [String] = []
        func check(_ holds: Bool, _ what: String) {
            if !holds { failures.append(what) }
        }

        let exchange = Exchange()
        let api = NotesAPI(
            baseURL: URL(string: "https://notes.example/api/")!,
            bearerToken: "token",
            userAgent: "Notes/1.0",
            transport: { request in try await exchange.take(request) },
        )

        // A list, with every query parameter, and what the server sends read back as it was sent.
        await exchange.answer(with: 200, try part("notes"))
        let notes = try await api.listNotes(since: "2026-10-24T00:00:00.000Z", limit: "5", color: .green, q: "a b&c=d/é")
        var request = await exchange.requests[0]
        check(request.httpMethod == "GET", "listNotes is a GET")
        check(
            request.url?.absoluteString == "https://notes.example/api/notes?since=2026-10-24T00%3A00%3A00.000Z&limit=5&color=green&q=a%20b%26c%3Dd%2F%C3%A9",
            "listNotes's query: \(request.url?.absoluteString ?? "")",
        )
        check(request.value(forHTTPHeaderField: "Authorization") == "Bearer token", "the bearer token is sent")
        check(request.value(forHTTPHeaderField: "User-Agent") == "Notes/1.0", "the User-Agent is sent")
        check(try json(encoded(notes)) == wire["notes"], "notes read and written back as Effect wrote them")
        check(notes.first?.score == -.infinity && notes.first?.extra["peak"] == .infinity, "numbers that aren't finite")
        check(notes.first?.body == nil && notes.last?.body == "Write the kit", "a required null")

        // A note by an ID with a slash, and the error the API names for one that isn't there.
        await exchange.answer(with: 200, try part("note"))
        await exchange.answer(with: 404, try part("noteNotFound"))
        let note = try await api.getNote(id: "n/1")
        request = await exchange.requests[1]
        check(request.url?.absoluteString == "https://notes.example/api/notes/n%2F1", "getNote's path: \(request.url?.absoluteString ?? "")")
        check(try json(encoded(note)) == wire["note"], "a note read and written back")
        do {
            _ = try await api.getNote(id: "missing")
            check(false, "getNote of a missing note fails")
        } catch .noteNotFound(let error) {
            check(error.id == "missing", "noteNotFound's id")
        } catch {
            check(false, "getNote of a missing note fails with noteNotFound, not \(error)")
        }
        // A path parameter's value is a segment of its own: one a URL reads as none, or as a step up
        // the path, isn't sent.
        let sent = await exchange.requests.count
        for id in ["", ".", ".."] {
            do {
                _ = try await api.getNote(id: id)
                check(false, "getNote(id: \"\(id)\") is refused")
            } catch .unwritable {
            } catch {
                check(false, "getNote(id: \"\(id)\") is unwritable, not \(error)")
            }
        }
        check(await exchange.requests.count == sent, "nothing is sent for a path parameter that isn't a segment")

        // A body as Effect takes it, a constant and a number that isn't finite in it; and errors.
        let draft = NewNote(title: "Draft", color: .red, shape: .square(Square(side: 2)), stamp: Circle(radius: .nan))
        await exchange.answer(with: 200, try part("note"))
        await exchange.answer(with: 403, try part("notAllowed"))
        await exchange.answer(with: 400, try part("badRequest"))
        await exchange.answer(with: 409, Data(#"{"_tag":"Conflict"}"#.utf8))
        _ = try await api.createNote(draft)
        request = await exchange.requests[3]
        check(request.httpMethod == "POST", "createNote is a POST")
        check(request.value(forHTTPHeaderField: "Content-Type") == "application/json", "a body is JSON")
        check(try request.httpBody.map(json) == wire["newNote"], "the body as Effect takes it")
        for expected in ["notAllowed", "badRequest", "unreadable"] {
            do {
                _ = try await api.createNote(draft)
                check(false, "createNote fails with \(expected)")
            } catch {
                switch (expected, error) {
                case ("notAllowed", .notAllowed(let reason)): check(reason.reason == "Read only", "notAllowed's reason")
                case ("badRequest", .badRequest): break
                case ("unreadable", .unreadable(let status, _)): check(status == 409, "an unknown error's status")
                default: check(false, "createNote fails with \(expected), not \(error)")
                }
            }
        }

        // No content, then no answer at all.
        await exchange.answer(with: 204)
        try await api.deleteNote(id: "n2")
        request = await exchange.requests[7]
        check(request.httpMethod == "DELETE", "deleteNote is a DELETE")
        do {
            try await api.deleteNote(id: "n2")
            check(false, "a call with no answer fails")
        } catch .unreachable(let error) {
            check(error.code == .notConnectedToInternet, "unreachable keeps the URL error")
        } catch {
            check(false, "a call with no answer fails with unreachable, not \(error)")
        }

        // A newer API's values: an enum value and a union's kind this client doesn't know, kept.
        let newer = try decoded(Note.self, Data(#"{"id":"n3","title":"T","body":null,"pinned":false,"color":"purple","tags":[],"createdAt":"2026-10-24T09:30:00.000Z","views":1,"score":1,"extra":{},"later":true}"#.utf8))
        check(newer.color.rawValue == "purple", "an enum value this client doesn't know")
        check(try decoded(Shape.self, Data(#"{"_tag":"Hexagon","edges":6}"#.utf8)) == .unknown("Hexagon"), "a kind this client doesn't know")
        check((try? decoded(Circle.self, Data(#"{"_tag":"Square","radius":1}"#.utf8))) == nil, "a constant that isn't its own")

        if failures.isEmpty {
            print("The Swift client reads and writes what Effect's server does.")
        } else {
            print(failures.map { "Failed: \($0)" }.joined(separator: "\n"))
            exit(1)
        }
    }
}
