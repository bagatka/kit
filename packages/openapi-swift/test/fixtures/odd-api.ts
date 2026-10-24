// A document of the names and text that would break a generated client if it wrote them as they
// are: Swift's keywords, raw identifiers, the names the client uses for itself, quotes, backslashes,
// and line breaks of every kind in its title and descriptions. Its Swift client is OddAPI.swift.

const string = { type: "string" } as const
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const constant = (value: string) => ({ type: "string", enum: [value] })

export const oddDocument = {
  openapi: "3.1.0",
  info: { title: "Odd\r// title: injected\u2028code", version: "1.0.0" },
  components: {
    schemas: {
      // Keys that are keywords, that start with a digit, that hold a space or a dash, and that name
      // what its Codable code holds.
      Answer: {
        type: "object",
        properties: {
          default: string,
          container: string,
          encoder: string,
          decoder: { type: "integer" },
          "1m": { type: "integer" },
          "a b": { anyOf: [string, { type: "null" }] },
          "kebab-key": { type: "array", items: ref("Kind") },
          type: ref("Kind"),
          init: { type: "boolean" },
          tree: ref("Tree"),
        },
        required: ["default", "container", "encoder", "1m", "a b", "type", "tree"],
      },
      // Values that are keywords, raw identifiers, and one with a quote and a backslash in it.
      Kind: { type: "string", enum: ["1m", "init", "a-b", "ok", "self"] },
      // Named as the client's own helpers used to be; held in an array, the tree refers to itself.
      Tree: {
        type: "object",
        properties: { label: string, children: { type: "array", items: ref("Tree") } },
        required: ["label", "children"],
      },
      Created: {
        type: "object",
        properties: { kind: constant('note.created "quoted" \\ back'), at: { type: "string", format: "date-time" } },
        required: ["kind", "at"],
      },
      Deleted: { type: "object", properties: { kind: constant("note-deleted") }, required: ["kind"] },
      // A constant whose key no stored property may have, as a constant is only a coding key.
      Hashed: { type: "object", properties: { hashValue: constant("hashed") }, required: ["hashValue"] },
      Event: { oneOf: [ref("Created"), ref("Deleted")], discriminator: { propertyName: "kind" } },
      Gone: { type: "object", properties: { code: constant("gone\nfor good") }, required: ["code"] },
    },
  },
  paths: {
    "/answers/{id}": {
      get: {
        operationId: "answers.get_answer",
        description: "Reads an answer.\r\n// injected: a line of code\n\n*/ not the end of anything \u2029 either",
        parameters: [
          { name: "id", in: "path", required: true, schema: string },
          { name: "query", in: "query", required: true, schema: string },
          { name: "body", in: "query", schema: { anyOf: [{ type: "integer" }, { type: "null" }] } },
          { name: "page[size]", in: "query", schema: { type: "number" } },
          { name: "default", in: "query", schema: ref("Kind") },
          { name: "at", in: "query", schema: { type: "string", format: "date-time" } },
        ],
        responses: {
          "200": { description: "The answer", content: { "application/json": { schema: ref("Answer") } } },
          "410": { description: "Gone", content: { "application/json": { schema: ref("Gone") } } },
        },
      },
      put: {
        operationId: "answers.put-answer",
        parameters: [{ name: "id", in: "path", required: true, schema: string }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "array", items: ref("Event") } } },
        },
        responses: { "204": { description: "Saved" } },
      },
    },
    // An operation named with a keyword.
    "/answers/{id}/again": {
      post: {
        operationId: "answers.repeat",
        parameters: [{ name: "id", in: "path", required: true, schema: string }],
        responses: { "204": { description: "Asked again" } },
      },
    },
  },
}
