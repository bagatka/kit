import { Effect } from "effect"

import type { Api, Declaration, ValueType } from "./read-document.ts"
import { at, readDocument } from "./read-document.ts"
import { stringLiteral, swiftName } from "./swift-names.ts"
import type { Problem } from "./unsupported-open-api.ts"
import { UnsupportedOpenApi } from "./unsupported-open-api.ts"
import { caseName, clientName, writeSwift } from "./write-swift.ts"

// The names the client gives its own coding keys, in each struct, and its own locals, in each
// method: raw identifiers, which a document's name can be too.
const ownKeys = "JSON keys"
const ownLocals = ["query items", "request body", "the answer"]

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
  "KeyedDecodingContainer",
  "Never",
  "Optional",
  "RawRepresentable",
  "RawValue",
  "Result",
  "Self",
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
): ReadonlyArray<Problem> => {
  // The first value that makes each case.
  const firstOf = new Map<string, string>()
  return values.flatMap((value) => {
    const name = caseName(value)
    const earlier = firstOf.get(name)
    if (earlier === undefined) {
      firstOf.set(name, value)
    }
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
}

// Why a parameter's name can't be written, if it can't.
const parameterProblem = (parameter: string, isRepeated: boolean): string | undefined => {
  if (swiftName(parameter) === undefined || parameter === "self" || parameter === "Self") {
    return "no Swift name can hold it"
  }
  if (ownLocals.includes(parameter)) {
    return `the client takes it for its own (${ownLocals.join(", ")})`
  }
  return isRepeated ? "another parameter has it" : undefined
}

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
          } else if (key === ownKeys) {
            problems.push({ path, reason: `a property's key the client takes for its own, ${ownKeys}` })
          } else if (isStored && key === "hashValue") {
            problems.push({ path, reason: "a property's key Swift's Hashable takes for itself" })
          }
        }
        break
      case "Enum": {
        const seen = new Set<string>()
        for (const value of declaration.values) {
          if (swiftName(value) === undefined || value === "rawValue") {
            problems.push({ path: schema(declaration.name), reason: `its value ${value} can't be a Swift name` })
          } else if (seen.has(value)) {
            problems.push({ path: schema(declaration.name), reason: `its value ${value} is given twice` })
          }
          seen.add(value)
        }
        break
      }
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
    const seen = new Set<string>()
    for (const { name: parameter } of [...operation.pathParameters, ...operation.queryParameters]) {
      const reason = parameterProblem(parameter, seen.has(parameter))
      seen.add(parameter)
      if (reason !== undefined) {
        problems.push({
          path: at("#/paths", operation.path),
          reason: `the parameter ${parameter} of ${operation.name}: ${reason}`,
        })
      }
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

// The types that hold themselves, through any others: those on a cycle of what each holds. One pass
// of Tarjan's strongly connected components, with a stack of its own rather than the call stack's,
// in time linear in the types and what they hold.
const typesHoldingThemselves = (api: Api): ReadonlySet<string> => {
  const holds = new Map(api.declarations.map((declaration) => [declaration.name, heldBy(declaration)]))
  const index = new Map<string, number>()
  const lowest = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: Array<string> = []
  const cyclic = new Set<string>()
  for (const root of holds.keys()) {
    if (index.has(root)) {
      continue
    }
    // Each type being visited, and how many of what it holds have been looked at.
    const visiting: Array<[string, number]> = [[root, 0]]
    index.set(root, index.size)
    lowest.set(root, index.get(root) ?? 0)
    stack.push(root)
    onStack.add(root)
    while (visiting.length > 0) {
      const top = visiting[visiting.length - 1]
      if (top === undefined) {
        break
      }
      const [name, next] = top
      const edges = holds.get(name) ?? []
      const child = edges[next]
      if (child !== undefined) {
        top[1] = next + 1
        if (!holds.has(child)) {
          continue
        }
        if (!index.has(child)) {
          index.set(child, index.size)
          lowest.set(child, index.get(child) ?? 0)
          stack.push(child)
          onStack.add(child)
          visiting.push([child, 0])
        } else if (onStack.has(child)) {
          lowest.set(name, Math.min(lowest.get(name) ?? 0, index.get(child) ?? 0))
        }
        continue
      }
      visiting.pop()
      const parent = visiting[visiting.length - 1]
      if (parent !== undefined) {
        lowest.set(parent[0], Math.min(lowest.get(parent[0]) ?? 0, lowest.get(name) ?? 0))
      }
      if (lowest.get(name) === index.get(name)) {
        const component: Array<string> = []
        for (let member = stack.pop(); member !== undefined; member = stack.pop()) {
          onStack.delete(member)
          component.push(member)
          if (member === name) {
            break
          }
        }
        if (component.length > 1 || edges.includes(name)) {
          for (const member of component) {
            cyclic.add(member)
          }
        }
      }
    }
  }
  return cyclic
}

// Each type that holds itself, through any others, other than in an array or a dictionary: a Swift
// struct can't, as its size would have no end.
const recursionProblems = (api: Api): ReadonlyArray<Problem> => {
  const cyclic = typesHoldingThemselves(api)
  return api.declarations
    .filter((declaration) => cyclic.has(declaration.name))
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
 * Pure, and takes time linear in the document and the Swift it writes; a schema nested more than
 * 100 deep, through references too, is refused.
 */
export const swiftClient = Effect.fn("swiftClient")(function* (document: unknown) {
  const { api, problems } = readDocument(document)
  const all = [...problems, ...nameProblems(api), ...recursionProblems(api)]
  if (all.length > 0) {
    return yield* new UnsupportedOpenApi({ problems: all })
  }
  return writeSwift(api)
})
