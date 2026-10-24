/**
 * Writes a typed Swift client of an HTTP API from its OpenAPI 3.1 document, such as Effect's
 * `HttpApi` writes: `Codable` value types, a typed error, and one `async` method per operation, on
 * Foundation alone.
 */
export { swiftClient } from "./swift-client.ts"
export { Problem, UnsupportedOpenApi } from "./unsupported-open-api.ts"
