import { camelCase, pascalCase } from "./swift-names.ts"
import type { Problem } from "./unsupported-open-api.ts"

// What the generator understands of a document: its named types and its operations, each read once
// from the document's JSON. Whatever it doesn't understand is a problem, with where and why; reading
// goes on past one, so every problem of a document is reported at once.

/** A value's type, as Swift holds it. */
export type ValueType =
  | { readonly _tag: "String" }
  | { readonly _tag: "Date" }
  | { readonly _tag: "Int" }
  | { readonly _tag: "Double" }
  | { readonly _tag: "Bool" }
  | { readonly _tag: "Json" }
  | { readonly _tag: "Array"; readonly of: ValueType }
  | { readonly _tag: "Dictionary"; readonly of: ValueType }
  | { readonly _tag: "Optional"; readonly of: ValueType }
  | { readonly _tag: "Named"; readonly name: string }

/** A property of an object, by its JSON key; `required` keys must be present, though maybe null. */
export interface Property {
  readonly key: string
  readonly type: ValueType
  readonly required: boolean
}

/** A property with one possible value, such as an error's `_tag`: it tells objects apart. */
export interface Constant {
  readonly key: string
  readonly value: string
}

export interface Struct {
  readonly _tag: "Struct"
  readonly name: string
  readonly properties: ReadonlyArray<Property>
  readonly constants: ReadonlyArray<Constant>
}

/**
 * A named type: an object; a set of strings; or a union of objects, told apart by the one constant
 * property they share, its `discriminator`.
 */
export type Declaration =
  | Struct
  | { readonly _tag: "Enum"; readonly name: string; readonly values: ReadonlyArray<string> }
  | {
      readonly _tag: "Union"
      readonly name: string
      readonly discriminator: string
      readonly cases: ReadonlyArray<{ readonly value: string; readonly type: string }>
    }

/** A path or query parameter, by its name in the request; `required` is read of a query parameter only. */
export interface Parameter {
  readonly name: string
  readonly type: ValueType
  readonly required: boolean
}

/** One operation of the API. */
export interface Operation {
  /** Its method's name: the last part of its operation ID, `phones.removePhone` as `removePhone`. */
  readonly name: string
  readonly description: string | undefined
  readonly method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE"
  /** Its path, each parameter in braces: `/api/phones/{phone}`. */
  readonly path: string
  readonly pathParameters: ReadonlyArray<Parameter>
  readonly queryParameters: ReadonlyArray<Parameter>
  /** What its JSON body holds, if it takes one. */
  readonly body: ValueType | undefined
  /** What a success holds; undefined when it has no body. */
  readonly result: ValueType | undefined
  /** The named errors it answers with. */
  readonly errors: ReadonlyArray<string>
}

/** An error the API answers with: its type, and the value of `Api.errorKey` that names it. */
export interface NamedError {
  readonly name: string
  readonly value: string
}

/** The document, as the generator understands it. */
export interface Api {
  readonly title: string
  readonly declarations: ReadonlyArray<Declaration>
  readonly operations: ReadonlyArray<Operation>
  /** Every named error any operation answers with, by name. */
  readonly errors: ReadonlyArray<NamedError>
  /** The constant property that tells errors apart, such as `_tag`; undefined when there are none. */
  readonly errorKey: string | undefined
}

type JsonRecord = Readonly<Record<string, unknown>>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/** A JSON pointer one key further in. */
export const at = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`

const schemasPath = "#/components/schemas"
const componentPrefix = `${schemasPath}/`

// A path as a URL holds it after the API's address: `/`, then segments of letters, digits, `-`,
// `.`, `_`, `~` and parameters, none of them `.` or `..`. Anything else could change what the
// address means, as `@other.example/x` would its host, or end in its query.
const isPath = (route: string): boolean =>
  route.startsWith("/") &&
  route
    .split("/")
    .every(
      (segment) =>
        /^(?:[A-Za-z0-9._~-]|\{[A-Za-z_][A-Za-z0-9_]*\})*$/.test(segment) && segment !== "." && segment !== "..",
    )

const methods = { get: "GET", put: "PUT", post: "POST", patch: "PATCH", delete: "DELETE" } as const
const isMethod = (key: string): key is keyof typeof methods => Object.hasOwn(methods, key)

// Keywords that describe or validate a value without changing its shape: Swift's types don't hold
// them, and the server checks them.
const describing = new Set([
  "$comment",
  "title",
  "description",
  "examples",
  "example",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "pattern",
  "minLength",
  "maxLength",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "contentEncoding",
  "contentMediaType",
])

// An `allOf` of checks alone, which Effect writes for a second check of a Schema, such as
// `allOf: [{ pattern: "..." }]` beside a first pattern: it describes, as its members' keywords do.
const isChecksOnly = (members: unknown): boolean =>
  Array.isArray(members) &&
  members.length > 0 &&
  members.every(
    (member) =>
      isRecord(member) &&
      Object.keys(member).length > 0 &&
      Object.keys(member).every((key) => describing.has(key) || key.startsWith("x-")),
  )

// The keywords a schema has besides those that describe it, which say its shape.
const shapeKeywords = (schema: JsonRecord): ReadonlyArray<string> =>
  Object.keys(schema).filter(
    (key) => !describing.has(key) && !key.startsWith("x-") && !(key === "allOf" && isChecksOnly(schema[key])),
  )

const nonFinite = ["Infinity", "-Infinity", "NaN"]

const scalars = { integer: "Int", number: "Double", boolean: "Bool" } as const

// Whether a JSON value is one of a scalar type's values.
const isOf =
  (type: keyof typeof scalars) =>
  (value: unknown): boolean =>
    type === "boolean"
      ? typeof value === "boolean"
      : typeof value === "number" && (type === "number" ? Number.isFinite(value) : Number.isSafeInteger(value))

// Effect's number: a finite number, or one of the strings it writes for the others.
const isEffectNumber = (members: ReadonlyArray<unknown>): boolean =>
  members.length === 2 &&
  members.some((member) => isRecord(member) && member["type"] === "number" && shapeKeywords(member).length === 1) &&
  members.some(
    (member) =>
      isRecord(member) &&
      member["type"] === "string" &&
      shapeKeywords(member).length === 2 &&
      isStrings(member["enum"]) &&
      member["enum"].length === nonFinite.length &&
      nonFinite.every((value) => isStrings(member["enum"]) && member["enum"].includes(value)),
  )

const isNull = (schema: unknown): boolean => isRecord(schema) && schema["type"] === "null"

// The members of a union, `anyOf` or `oneOf`, if the schema is one.
const membersOf = (schema: JsonRecord): ReadonlyArray<unknown> | undefined => {
  const members = schema["anyOf"] ?? schema["oneOf"]
  return Array.isArray(members) ? members : undefined
}

// The keyword a union's members are under, for where a problem with one is.
const membersKeyOf = (schema: JsonRecord): "anyOf" | "oneOf" => (Array.isArray(schema["anyOf"]) ? "anyOf" : "oneOf")

// The one value of a single-valued string enum, the way a constant property is written.
const constantOf = (schema: unknown): string | undefined =>
  isRecord(schema) &&
  schema["type"] === "string" &&
  shapeKeywords(schema).length === 2 &&
  isStrings(schema["enum"]) &&
  schema["enum"].length === 1
    ? schema["enum"][0]
    : undefined

// Whether two JSON values are alike, whatever the order of their keys.
const sameJson = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => sameJson(item, b[index]))
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return (
      keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
    )
  }
  return a === b
}

// Each schema's Swift name. Effect names an encoded form `<Name>Encoded`, which is `<Name>` here
// unless that names another schema, and its own errors' forms `effect_HttpApiError_<Name>Encoded`;
// a name that isn't a Swift type's is written as one, `EffectHttpApiErrorBadRequest`. A schema named
// `<Name>_<n>` that is the same as `<Name>`, a second copy of one a document annotates, is
// `<Name>`'s type.
const swiftNamesOf = (schemas: JsonRecord): ReadonlyMap<string, string> => {
  const names = new Map<string, string>()
  for (const name of Object.keys(schemas)) {
    const stripped = name.endsWith("Encoded") ? name.slice(0, -"Encoded".length) : name
    const unencoded = stripped !== "" && !Object.hasOwn(schemas, stripped) ? stripped : name
    names.set(name, pascalCase(unencoded))
  }
  for (const name of Object.keys(schemas)) {
    const original = /^(.+)_\d+$/.exec(name)?.[1]
    if (original !== undefined && Object.hasOwn(schemas, original) && sameJson(schemas[original], schemas[name])) {
      names.set(name, names.get(original) ?? original)
    }
  }
  return names
}

// By name, in code point order, the same on every machine.
const byName = (left: { readonly name: string }, right: { readonly name: string }): number =>
  left.name < right.name ? -1 : Number(left.name > right.name)

/**
 * Reads `document`, an OpenAPI 3.1 document as JSON, into what the generator writes Swift from, and
 * every problem that keeps it from being written; with problems, the API holds what could be read.
 */
export const readDocument = (document: unknown): { readonly api: Api; readonly problems: ReadonlyArray<Problem> } => {
  const problems: Array<Problem> = []
  const problem = (path: string, reason: string): undefined => {
    problems.push({ path, reason })
    return undefined
  }

  if (!isRecord(document)) {
    const empty: Api = { title: "", declarations: [], operations: [], errors: [], errorKey: undefined }
    return { api: empty, problems: [{ path: "#", reason: "the document isn't a JSON object" }] }
  }
  const version = document["openapi"]
  if (typeof version !== "string" || !/^3\.1\.\d+$/.test(version)) {
    problem("#/openapi", "the document isn't OpenAPI 3.1")
  }
  const info = document["info"]
  const title = isRecord(info) && typeof info["title"] === "string" ? info["title"] : ""
  if (title === "") {
    problem("#/info/title", "the document has no title, which names the client")
  }
  const components = isRecord(document["components"]) ? document["components"] : {}
  const schemas = isRecord(components["schemas"]) ? components["schemas"] : {}
  const paths = isRecord(document["paths"]) ? document["paths"] : {}
  const swiftNames = swiftNamesOf(schemas)

  // Each Swift name's schema, by its name in the document: the first of copies, which are alike.
  const firstOf = new Map<string, string>()
  for (const [name, schema] of Object.entries(schemas)) {
    const swift = swiftNames.get(name) ?? name
    const first = firstOf.get(swift)
    if (first === undefined) {
      firstOf.set(swift, name)
    } else if (!sameJson(schemas[first], schema)) {
      problem(at(schemasPath, name), `another schema is also named ${swift} in Swift`)
    }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(swift)) {
      problem(
        at(schemasPath, name),
        "a schema's name must make a Swift type name: letters and digits, not a digit first",
      )
    }
  }

  // What a named schema is: a declaration of its own, or the value type it stands for.
  const isDeclared = (schema: unknown): boolean => {
    if (!isRecord(schema)) {
      return false
    }
    const members = membersOf(schema)
    return (
      (schema["type"] === "string" && isStrings(schema["enum"]) && schema["enum"].length > 1) ||
      (schema["type"] === "object" && isRecord(schema["properties"]) && Object.keys(schema["properties"]).length > 0) ||
      (members !== undefined && !isEffectNumber(members) && !(members.length === 2 && members.some(isNull)))
    )
  }

  // Named schemas that stand for a value type, while one is being read, so one that refers to
  // itself is a problem rather than a loop.
  const resolving = new Set<string>()
  // Each named value type once read, a problem included, so a document that refers to one many
  // times is read in time linear in its size.
  const resolved = new Map<string, ValueType | undefined>()

  const valueType = (schema: unknown, path: string): ValueType | undefined => {
    if (!isRecord(schema)) {
      return problem(path, "a schema must be an object")
    }
    const shape = shapeKeywords(schema)
    const ref = schema["$ref"]
    if (typeof ref === "string") {
      const referenced = ref.startsWith(componentPrefix) ? ref.slice(componentPrefix.length) : undefined
      if (referenced === undefined || !Object.hasOwn(schemas, referenced)) {
        return problem(path, `a reference to ${ref}, which isn't one of the document's schemas`)
      }
      if (shape.length > 1) {
        return problem(path, `a reference with ${shape.filter((key) => key !== "$ref").join(", ")} beside it`)
      }
      const name = swiftNames.get(referenced) ?? referenced
      const target = schemas[referenced]
      if (isDeclared(target)) {
        return { _tag: "Named", name }
      }
      if (resolving.has(name)) {
        return problem(path, `${name} stands for a value that holds itself`)
      }
      if (!resolved.has(referenced)) {
        resolving.add(name)
        resolved.set(referenced, valueType(target, at(schemasPath, referenced)))
        resolving.delete(name)
      }
      return resolved.get(referenced)
    }
    const anyOf = membersOf(schema)
    if (anyOf !== undefined) {
      // A union says its shape with its members alone, nothing beside them.
      const beside = shape.filter((key) => key !== membersKeyOf(schema))
      if (beside.length > 0) {
        return problem(path, `the keywords ${beside.join(", ")}, which no Swift type here holds`)
      }
      if (isEffectNumber(anyOf)) {
        return { _tag: "Double" }
      }
      const others = anyOf.filter((member) => !isNull(member))
      const [only] = others
      if (anyOf.length === 2 && others.length === 1) {
        const inner = valueType(only, at(at(path, membersKeyOf(schema)), anyOf.indexOf(only)))
        return inner === undefined || inner._tag === "Optional" ? inner : { _tag: "Optional", of: inner }
      }
      return problem(path, "a union here: name it as a schema of its own")
    }
    const type = schema["type"]
    if (Array.isArray(type)) {
      const [first, second, ...more] = type
      const of = first === "null" ? second : first
      if (more.length > 0 || !type.includes("null") || typeof of !== "string" || of === "null") {
        return problem(path, "a type of several types, other than one and null")
      }
      const inner = valueType({ ...schema, type: of }, path)
      return inner === undefined ? undefined : { _tag: "Optional", of: inner }
    }
    const unsupported = shape.filter(
      (key) => !["type", "enum", "items", "properties", "required", "additionalProperties"].includes(key),
    )
    if (unsupported.length > 0) {
      return problem(path, `the keywords ${unsupported.join(", ")}, which no Swift type here holds`)
    }
    switch (type) {
      case "string":
        if (isStrings(schema["enum"])) {
          return problem(
            path,
            schema["enum"].length === 1
              ? "a constant here: only an object's property may be one"
              : "an inline enum: name it as a schema of its own",
          )
        }
        if ("enum" in schema) {
          return problem(path, "an enum of other values than strings")
        }
        return schema["format"] === "date-time" ? { _tag: "Date" } : { _tag: "String" }
      case "integer":
      case "number":
      case "boolean": {
        // An enum of its own type's values, such as `[true]` for a Schema.Literal(true), is that
        // type: the server checks which values. One of other values is refused.
        const values = schema["enum"]
        if ("enum" in schema && !(Array.isArray(values) && values.length > 0 && values.every(isOf(type)))) {
          return problem(path, `an enum of other values than ${type}s`)
        }
        return { _tag: scalars[type] }
      }
      case "array": {
        const items = valueType(schema["items"], at(path, "items"))
        return items === undefined ? undefined : { _tag: "Array", of: items }
      }
      case "object": {
        if (isRecord(schema["properties"]) && Object.keys(schema["properties"]).length > 0) {
          return problem(path, "an inline object: name it as a schema of its own")
        }
        const values = schema["additionalProperties"]
        if (!isRecord(values)) {
          return { _tag: "Dictionary", of: { _tag: "Json" } }
        }
        const of = valueType(values, at(path, "additionalProperties"))
        return of === undefined ? undefined : { _tag: "Dictionary", of }
      }
      case undefined:
        // No shape at all: any JSON value.
        return shape.length === 0 ? { _tag: "Json" } : problem(path, "a schema with no type")
      default:
        return problem(path, `a type of ${String(type)}, which has no Swift type here`)
    }
  }

  // Objects first, so unions and errors can find their members' constants.
  const structs = new Map<string, Struct>()
  const declarations: Array<Declaration> = []
  const unions: Array<readonly [string, string, unknown]> = []
  for (const [schemaName, schema] of Object.entries(schemas)) {
    const name = swiftNames.get(schemaName) ?? schemaName
    const path = at(schemasPath, schemaName)
    if (!isDeclared(schema) || !isRecord(schema) || firstOf.get(name) !== schemaName) {
      // A value type, read where it is used; or a copy of a declaration.
      continue
    }
    if (schema["type"] === "string") {
      const extra = shapeKeywords(schema).filter((key) => key !== "type" && key !== "enum")
      if (extra.length > 0) {
        problem(path, `the keywords ${extra.join(", ")}, which no Swift type here holds`)
      }
      declarations.push({ _tag: "Enum", name, values: isStrings(schema["enum"]) ? schema["enum"] : [] })
      continue
    }
    if (schema["type"] !== "object") {
      const extra = shapeKeywords(schema).filter((key) => !["anyOf", "oneOf", "discriminator"].includes(key))
      if (extra.length > 0) {
        problem(path, `the keywords ${extra.join(", ")}, which no Swift type here holds`)
      }
      unions.push([name, path, schema])
      continue
    }
    const unsupported = shapeKeywords(schema).filter(
      (key) => !["type", "properties", "required", "additionalProperties"].includes(key),
    )
    if (unsupported.length > 0) {
      problem(path, `the keywords ${unsupported.join(", ")}, which no Swift type here holds`)
      continue
    }
    const required = isStrings(schema["required"]) ? schema["required"] : []
    const properties: Array<Property> = []
    const constants: Array<Constant> = []
    for (const [key, property] of Object.entries(isRecord(schema["properties"]) ? schema["properties"] : {})) {
      const propertyPath = at(at(path, "properties"), key)
      const constant = constantOf(property)
      if (constant !== undefined) {
        if (required.includes(key)) {
          constants.push({ key, value: constant })
        } else {
          problem(propertyPath, "a constant that may be missing: make it required")
        }
        continue
      }
      const type = valueType(property, propertyPath)
      if (type !== undefined) {
        properties.push({ key, type, required: required.includes(key) })
      }
    }
    const declaration: Struct = { _tag: "Struct", name, properties, constants }
    structs.set(name, declaration)
    declarations.push(declaration)
  }
  for (const [name, path, schema] of unions) {
    const members = isRecord(schema) ? membersOf(schema) : undefined
    const memberPath = at(path, isRecord(schema) ? membersKeyOf(schema) : "anyOf")
    const types: Array<Struct> = []
    for (const [index, member] of (members ?? []).entries()) {
      const type = valueType(member, at(memberPath, index))
      const struct = type?._tag === "Named" ? structs.get(type.name) : undefined
      if (struct === undefined) {
        problem(at(memberPath, index), "a union's members must be named objects")
      } else {
        types.push(struct)
      }
    }
    // The keys every member has a constant of.
    const [first, ...others] = types
    const shared = (first?.constants ?? [])
      .map((constant) => constant.key)
      .filter((key) => others.every((struct) => struct.constants.some((constant) => constant.key === key)))
    const [discriminator, ...more] = shared
    if (discriminator === undefined || more.length > 0) {
      problem(path, "a union's members must share exactly one constant property, such as _tag")
      continue
    }
    const stated =
      isRecord(schema) && isRecord(schema["discriminator"]) ? schema["discriminator"]["propertyName"] : discriminator
    if (stated !== discriminator) {
      problem(at(path, "discriminator"), `the discriminator must be ${discriminator}, the constant the members share`)
    }
    const cases = types.map((struct) => ({
      value: struct.constants.find((constant) => constant.key === discriminator)?.value ?? "",
      type: struct.name,
    }))
    if (new Set(cases.map((entry) => entry.value)).size !== cases.length) {
      problem(path, `a union's members must each have their own ${discriminator}`)
    }
    declarations.push({ _tag: "Union", name, discriminator, cases })
  }

  const isError = (name: string) => structs.get(name)?.constants.length === 1

  // An error response's errors, by name: a named error, or each of a union of them, named or not.
  const errorNames = (schema: unknown, path: string): ReadonlyArray<string> => {
    const members = isRecord(schema) ? (membersOf(schema) ?? [schema]) : [schema]
    const memberPath = isRecord(schema) ? at(path, membersKeyOf(schema)) : path
    const names = members.flatMap((member, index) => {
      const type = valueType(member, members.length === 1 ? path : at(memberPath, index))
      const named = type?._tag === "Named" ? type.name : undefined
      const union = declarations.find((declaration) => declaration.name === named)
      if (union?._tag === "Union") {
        return union.cases.map((entry) => entry.type)
      }
      return named === undefined ? [""] : [named]
    })
    if (names.length === 0 || !names.every(isError)) {
      problem(path, "an error must be a named object with one constant property, such as _tag, or a union of them")
      return []
    }
    return names
  }

  const operations: Array<Operation> = []
  for (const [route, item] of Object.entries(paths)) {
    const itemPath = at("#/paths", route)
    if (!isPath(route)) {
      problem(
        itemPath,
        "a path is / and segments of letters, digits, -, ., _, ~ and {parameters}, none of them . or ..",
      )
      continue
    }
    if (!isRecord(item)) {
      problem(itemPath, "a path's operations must be an object")
      continue
    }
    for (const [key, operation] of Object.entries(item)) {
      const path = at(itemPath, key)
      if (key === "summary" || key === "description" || key.startsWith("x-")) {
        continue
      }
      if (!isMethod(key) || !isRecord(operation)) {
        problem(path, "only GET, PUT, POST, PATCH and DELETE operations are supported, and parameters on each")
        continue
      }
      const id = operation["operationId"]
      const name = typeof id === "string" ? camelCase(id.split(".").at(-1) ?? "") : ""
      if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
        problem(at(path, "operationId"), "an operation needs an ID whose last part is a Swift name")
      } else if (operations.some((other) => other.name === name)) {
        problem(at(path, "operationId"), `another operation is already called ${name}`)
      }

      const pathParameters: Array<Parameter> = []
      const queryParameters: Array<Parameter> = []
      const parameters = Array.isArray(operation["parameters"]) ? operation["parameters"] : []
      for (const [index, parameter] of parameters.entries()) {
        const parameterPath = at(at(path, "parameters"), index)
        if (!isRecord(parameter) || typeof parameter["name"] !== "string" || parameter["name"] === "") {
          problem(parameterPath, "a parameter needs a name")
          continue
        }
        const type = valueType(parameter["schema"], at(parameterPath, "schema"))
        if (type === undefined) {
          continue
        }
        const scalar = type._tag === "Optional" ? type.of : type
        const isText =
          ["String", "Date", "Int", "Double", "Bool"].includes(scalar._tag) ||
          declarations.some(
            (declaration) => declaration._tag === "Enum" && scalar._tag === "Named" && declaration.name === scalar.name,
          )
        if (!isText) {
          problem(parameterPath, "a parameter must be a string, a number, a boolean, a date, or an enum")
          continue
        }
        const read = {
          name: parameter["name"],
          type: scalar,
          required: parameter["required"] === true && type._tag !== "Optional",
        }
        if (parameter["in"] === "path") {
          pathParameters.push(read)
        } else if (parameter["in"] === "query") {
          queryParameters.push(read)
        } else {
          problem(parameterPath, "only path and query parameters are supported")
        }
      }
      const named = new Set(pathParameters.map((parameter) => parameter.name))
      const inPath = Array.from(route.matchAll(/\{([^}]*)\}/g), (match) => match[1] ?? "")
      if (inPath.length !== named.size || !inPath.every((parameter) => named.has(parameter))) {
        problem(path, "the path's parameters and the operation's path parameters must be the same")
      }

      let body: ValueType | undefined
      const requestBody = operation["requestBody"]
      if (requestBody !== undefined) {
        const content = isRecord(requestBody) && isRecord(requestBody["content"]) ? requestBody["content"] : {}
        const json = content["application/json"]
        if (!isRecord(json) || Object.keys(content).length !== 1) {
          problem(at(path, "requestBody"), "a body must be JSON, application/json, only")
        } else if (!isRecord(requestBody) || requestBody["required"] !== true) {
          problem(at(path, "requestBody"), "a body must be required: an optional one isn't supported")
        } else {
          body = valueType(json["schema"], at(at(at(path, "requestBody"), "content"), "application/json"))
        }
      }

      let result: ValueType | undefined
      let succeeds = false
      const errors: Array<string> = []
      const responses = isRecord(operation["responses"]) ? operation["responses"] : {}
      for (const [status, response] of Object.entries(responses)) {
        const responsePath = at(at(path, "responses"), status)
        const content = isRecord(response) && isRecord(response["content"]) ? response["content"] : {}
        const json = content["application/json"]
        const contentTypes = Object.keys(content)
        const isJson = contentTypes.length === 1 && isRecord(json)
        if (!/^[1-5]\d\d$/.test(status)) {
          problem(responsePath, "a response must have a status code: default and ranges such as 2XX aren't supported")
        } else if (status.startsWith("2")) {
          if (succeeds) {
            problem(responsePath, "an operation may answer with one success status only")
          }
          succeeds = true
          if (contentTypes.length > 0 && !isJson) {
            problem(responsePath, "a success must have a JSON body, application/json, or none")
          } else if (isJson) {
            result = valueType(json["schema"], at(at(responsePath, "content"), "application/json"))
          }
        } else if (status.startsWith("4") || status.startsWith("5")) {
          if (!isJson) {
            problem(responsePath, "an error must have a JSON body, application/json, of a named error")
          } else {
            errors.push(...errorNames(json["schema"], at(at(responsePath, "content"), "application/json")))
          }
        } else {
          problem(responsePath, "responses must have a 2xx, 4xx or 5xx status")
        }
      }
      if (!succeeds) {
        problem(at(path, "responses"), "an operation must answer with a 2xx status")
      }

      const description = operation["description"] ?? operation["summary"]
      operations.push({
        name,
        description: typeof description === "string" ? description : undefined,
        method: methods[key],
        path: route,
        pathParameters,
        queryParameters,
        body,
        result,
        errors: [...new Set(errors)],
      })
    }
  }

  const errorList = [...new Set(operations.flatMap((operation) => operation.errors))].toSorted().flatMap((name) => {
    const constant = structs.get(name)?.constants[0]
    return constant === undefined ? [] : [{ name, ...constant }]
  })
  const errorKey = errorList[0]?.key
  for (const mixed of errorList.filter((error) => error.key !== errorKey)) {
    problem(
      at(schemasPath, mixed.name),
      `every error must be told apart by the same property; ${mixed.name} uses ${mixed.key}, not ${errorKey ?? ""}`,
    )
  }
  const seenValues = new Set<string>()
  for (const error of errorList) {
    if (seenValues.has(error.value)) {
      problem(at(schemasPath, error.name), `another error is also named ${error.value}`)
    }
    seenValues.add(error.value)
  }

  const api: Api = {
    title,
    declarations: declarations.toSorted(byName),
    operations,
    errors: errorList.map(({ name, value }) => ({ name, value })),
    errorKey,
  }
  return { api, problems }
}
