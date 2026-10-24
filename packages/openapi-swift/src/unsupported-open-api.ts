import { Schema } from "effect"

/** Something in a document no Swift client is written for: where, as a JSON pointer, and why. */
export const Problem = Schema.Struct({
  /** Where, such as `#/components/schemas/Phone/properties/lastSeen`. */
  path: Schema.String,
  /** What isn't supported, and how to change it, such as naming an inline object as a schema. */
  reason: Schema.String,
})
export type Problem = typeof Problem.Type

/**
 * The document has things no Swift client is written for: `problems` lists every one, where and
 * why. Writing it again won't help: change the document, or the API it is written from.
 */
export class UnsupportedOpenApi extends Schema.TaggedError<UnsupportedOpenApi>()("UnsupportedOpenApi", {
  problems: Schema.Array(Problem),
}) {
  override get message(): string {
    const lines = this.problems.map((problem) => `${problem.path}: ${problem.reason}`)
    return `No Swift client is written for this document:\n${lines.join("\n")}`
  }
}
