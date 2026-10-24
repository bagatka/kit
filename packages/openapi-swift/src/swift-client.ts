import { Effect } from "effect"

import type { Api, Declaration, ValueType } from "./read-document.ts"
import { at, readDocument } from "./read-document.ts"
import { stringLiteral, swiftName } from "./swift-names.ts"
import type { Problem } from "./unsupported-open-api.ts"
import { UnsupportedOpenApi } from "./unsupported-open-api.ts"
import { caseName, clientName, writeSwift } from "./write-swift.ts"

// Type names the Swift file declares or uses, from itself, Swift and Foundation, and the ones an app
// uses most, which a type of the API would hide in the app's module.
const reservedTypes = new Set([
  "APIError",
  "JSONValue",
  "Transport",
  "Swift",
  "Foundation",
  "FoundationNetworking",
  "Any",
  "AnyObject",
  "Array",
  "Bool",
  "CancellationError",
  "Character",
  "CharacterSet",
  "Codable",
  "CodingKey",
  "Data",
  "Date",
  "Decodable",
  "Decoder",
  "DecodingError",
  "Dictionary",
  "Double",
  "Encodable",
  "Encoder",
  "EncodingError",
  "Equatable",
  "Error",
  "Float",
  "Hashable",
  "HTTPURLResponse",
  "Identifiable",
  "Int",
  "Int8",
  "Int16",
  "Int32",
  "Int64",
  "JSONDecoder",
  "JSONEncoder",
  "Never",
  "Optional",
  "RawRepresentable",
  "Result",
  "Sendable",
  "Set",
  "String",
  "Task",
  "UInt",
  "UInt8",
  "UInt16",
  "UInt32",
  "UInt64",
  "URL",
  "URLError",
  "URLRequest",
  "URLResponse",
  "URLSession",
  "UUID",
  "Void",
])

const schema = (declaration: string): string => at("#/components/schemas", declaration)

// What keeps the values that name an enum's cases, a union's kinds or the API's errors, from each
// making a case of its own: one that makes no Swift name, two that make one, or one that makes a
// case the enum takes for itself.
const caseProblems = (
  path: string,
  values: ReadonlyArray<string>,
  taken: ReadonlyArray<string>,
  of: string,
): ReadonlyArray<Problem> =>
  values.flatMap((value, index) => {
    const name = caseName(value)
    const earlier = values.slice(0, index).find((other) => caseName(other) === name)
    if (swiftName(name) === undefined) {
      return [{ path, reason: `${stringLiteral(value)} makes no Swift case name of ${of}: give it a letter` }]
    }
    if (taken.includes(name)) {
      return [{ path, reason: `${stringLiteral(value)} makes the case ${name}, which ${of} takes for itself` }]
    }
    if (earlier !== undefined) {
      return [
        { path, reason: `${stringLiteral(earlier)} and ${stringLiteral(value)} both make the case ${name} of ${of}` },
      ]
    }
    return []
  })

// What the API's names would make of the Swift file: every name that can't be written, and every
// name two things would share.
const nameProblems = (api: Api): ReadonlyArray<Problem> => {
  const problems: Array<Problem> = []
  const client = clientName(api)
  if (!/^[A-Z][A-Za-z0-9]*$/.test(client)) {
    problems.push({ path: "#/info/title", reason: `the client's name, ${client}, isn't a Swift type name` })
  }
  for (const declaration of api.declarations) {
    if (reservedTypes.has(declaration.name) || declaration.name === client) {
      problems.push({
        path: schema(declaration.name),
        reason: `${declaration.name} is a name the Swift client, Swift or Foundation takes; rename the schema`,
      })
    }
    switch (declaration._tag) {
      case "Struct":
        // A constant's key is a coding key only; a property's is a stored property too.
        for (const [key, isStored] of [
          ...declaration.constants.map((constant) => [constant.key, false] as const),
          ...declaration.properties.map((property) => [property.key, true] as const),
        ]) {
          const path = at(at(schema(declaration.name), "properties"), key)
          if (swiftName(key) === undefined || key === "self" || key === "Self") {
            problems.push({ path, reason: "a property's key no Swift name can hold" })
          } else if (isStored && key === "hashValue") {
            problems.push({ path, reason: "a property's key Swift's Hashable takes for itself" })
          }
        }
        break
      case "Enum":
        for (const [index, value] of declaration.values.entries()) {
          if (swiftName(value) === undefined || value === "rawValue") {
            problems.push({ path: schema(declaration.name), reason: `its value ${value} can't be a Swift name` })
          } else if (declaration.values.indexOf(value) !== index) {
            problems.push({ path: schema(declaration.name), reason: `its value ${value} is given twice` })
          }
        }
        break
      case "Union":
        problems.push(
          ...caseProblems(
            schema(declaration.name),
            declaration.cases.map((entry) => entry.value),
            ["unknown"],
            "the union",
          ),
        )
        break
    }
  }
  problems.push(
    ...caseProblems(
      "#/components/schemas",
      api.errors.map((error) => error.value),
      ["unreachable", "unreadable", "unwritable"],
      "APIError",
    ),
  )
  for (const operation of api.operations) {
    const names = [...operation.pathParameters, ...operation.queryParameters].map((parameter) => parameter.name)
    const unwritable = names.find(
      (parameter, index) =>
        swiftName(parameter) === undefined ||
        parameter === "self" ||
        parameter === "Self" ||
        names.indexOf(parameter) !== index,
    )
    if (unwritable !== undefined) {
      problems.push({
        path: at("#/paths", operation.path),
        reason: `the parameter ${unwritable} of ${operation.name} can't be a Swift name, or two share one`,
      })
    }
  }
  return problems
}

// The named types a value holds as itself: an optional one too, and an array or a dictionary none.
const held = (type: ValueType): ReadonlyArray<string> => {
  if (type._tag === "Optional") {
    return held(type.of)
  }
  return type._tag === "Named" ? [type.name] : []
}

// The named types a type holds as itself, not in an array or a dictionary, which may hold none.
const heldBy = (declaration: Declaration): ReadonlyArray<string> => {
  switch (declaration._tag) {
    case "Struct":
      return declaration.properties.flatMap((property) => held(property.type))
    case "Union":
      return declaration.cases.map((entry) => entry.type)
    case "Enum":
      return []
  }
}

// Each type that holds itself, through any others, other than in an array or a dictionary: a Swift
// struct can't, as its size would have no end.
const recursionProblems = (api: Api): ReadonlyArray<Problem> => {
  const declared = new Map(api.declarations.map((declaration) => [declaration.name, declaration]))
  const holdsItself = (start: Declaration): boolean => {
    const seen = new Set<string>()
    const waiting = [...heldBy(start)]
    for (let next = waiting.pop(); next !== undefined; next = waiting.pop()) {
      if (next === start.name) {
        return true
      }
      const declaration = declared.get(next)
      if (!seen.has(next) && declaration !== undefined) {
        seen.add(next)
        waiting.push(...heldBy(declaration))
      }
    }
    return false
  }
  return api.declarations
    .filter((declaration) => holdsItself(declaration))
    .map((declaration) => ({
      path: at("#/components/schemas", declaration.name),
      reason: `${declaration.name} holds itself, other than in an array or a dictionary: Swift's structs can't`,
    }))
}

/**
 * Swift source for a typed client of `document`, an OpenAPI 3.1 document as JSON: one file of
 * `Codable` value types, an `APIError` of the errors the API names, and a client with one `async`
 * method per operation, on `URLSession` and Foundation alone, for Swift 6.2 and later.
 *
 * It reads the shapes an API built from named schemas has, as Effect's `HttpApi` writes them:
 * objects, string enums, unions of objects told apart by one constant property such as `_tag`,
 * arrays, dictionaries, free-form JSON, nullable values, dates (`format: date-time`), and numbers
 * that may not be finite. Fails with `UnsupportedOpenApi`, listing every problem with where and
 * why, for anything else, such as an inline object, which needs a name to become a Swift type.
 * Pure, and takes time linear in the document.
 */
export const swiftClient = Effect.fn("swiftClient")(function* (document: unknown) {
  const { api, problems } = readDocument(document)
  const all = [...problems, ...nameProblems(api), ...recursionProblems(api)]
  if (all.length > 0) {
    return yield* new UnsupportedOpenApi({ problems: all })
  }
  return writeSwift(api)
})
