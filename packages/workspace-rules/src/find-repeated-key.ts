import { Effect, Option, Schema } from "effect"

// A key's JSON string literal, `"\u0061"`, to the key it names, `a`.
const decodeKey = Schema.decodeEffect(Schema.fromJsonString(Schema.String))

/**
 * The first key that appears twice in one object of `json`, at any depth, or `None`. Keys compare
 * by their decoded value, so `"a"` and `"\u0061"` are the same key. Package managers disagree on
 * which of two such keys counts: Bun reads the first, JSON's parsers the last.
 *
 * `json` must already have parsed as JSON. Reads each character once, keeping one set of keys for
 * each object that is open at that point, so time and memory are linear in `json`'s length.
 */
export const findRepeatedKey = Effect.fnUntraced(function* (json: string) {
  // For each object or array open at `index`: the keys an object has had so far, `undefined` for an
  // array. Strings are skipped whole, so a brace or a quote inside one is never read as structure.
  const open: Array<Set<string> | undefined> = []
  // Scanner state, advanced by the loop below.
  let index = 0
  let atKey = false
  while (index < json.length) {
    const character = json[index]
    const keys = open.at(-1)
    if (character === '"') {
      const end = endOfString(json, index)
      const isKey = atKey && keys !== undefined
      if (isKey) {
        // The text parsed as JSON, so this is a whole string literal and decodes; failing is a bug.
        const key = yield* decodeKey(json.slice(index, end + 1)).pipe(Effect.orDie)
        if (keys.has(key)) {
          return Option.some(key)
        }
        keys.add(key)
      }
      atKey = false
      index = end + 1
      continue
    }
    if (character === "{") {
      open.push(new Set())
      atKey = true
    } else if (character === "[") {
      open.push(undefined)
      atKey = false
    } else if (character === "}" || character === "]") {
      open.pop()
      atKey = false
    } else if (character === ",") {
      atKey = keys !== undefined
    }
    index += 1
  }
  return Option.none<string>()
})

// The index of the quote that closes the string whose opening quote is at `start`.
const endOfString = (json: string, start: number): number => {
  let index = start + 1
  while (index < json.length && json[index] !== '"') {
    index += json[index] === "\\" ? 2 : 1
  }
  return index
}
