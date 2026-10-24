import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/cli"

import { runToEnd } from "./run-to-end.ts"

/** `bun run check:swift` found Swift that doesn't compile or doesn't do what Effect's server does. */
export class SwiftCheckFailed extends Schema.TaggedError<SwiftCheckFailed>()("SwiftCheckFailed", {
  problems: Schema.Int,
}) {}

// The Swift clients @bagatka/openapi-swift writes for its tests, which its tests keep current.
const fixtures = "packages/openapi-swift/test/fixtures"
const clients = ["NotesAPI.swift", "OddAPI.swift"]

// An app's default isolation, the main actor, as Xcode's new app targets have it, and a library's.
const isolations = ["MainActor", "nonisolated"]

/**
 * `bun run check:swift`: the Swift clients openapi-swift writes compile with Swift 6, warnings as
 * errors, in both default isolations; and the Notes API's client, called through a transport that
 * answers as Effect's server does, sends and reads what that server does
 * (`packages/openapi-swift/test/fixtures/round-trip.swift`). Needs Swift 6.2 or later: Xcode's on a
 * Mac, through `xcrun`, or `swiftc` on the path.
 */
export const swift = Command.make("swift", {}, () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const folder = yield* fs.makeTempDirectoryScoped({ prefix: "bagatka-kit-swift-" }).pipe(Effect.orDie)
    const viaXcode = yield* runToEnd("xcrun", ["--find", "swiftc"], ".").pipe(Effect.option)
    const [command, ...prefix] =
      viaXcode._tag === "Some" && viaXcode.value.exitCode === 0 ? ["xcrun", "swiftc"] : ["swiftc"]
    const swiftc = (args: ReadonlyArray<string>) => runToEnd(command ?? "swiftc", [...prefix, ...args], ".")

    const problems: Array<string> = []
    for (const isolation of isolations) {
      const settings = [
        "-swift-version",
        "6",
        "-default-isolation",
        isolation,
        "-warnings-as-errors",
        "-parse-as-library",
      ]
      for (const client of clients) {
        const typed = yield* swiftc([...settings, "-typecheck", path.join(fixtures, client)])
        if (typed.exitCode !== 0) {
          problems.push(`${client}, isolated to ${isolation} by default, doesn't compile:\n${typed.output}`)
        }
      }
      const program = path.join(folder, `round-trip-${isolation}`)
      const built = yield* swiftc([
        ...settings,
        path.join(fixtures, "NotesAPI.swift"),
        path.join(fixtures, "round-trip.swift"),
        "-o",
        program,
      ])
      if (built.exitCode !== 0) {
        problems.push(`The round trip, isolated to ${isolation} by default, doesn't compile:\n${built.output}`)
        continue
      }
      const ran = yield* runToEnd(program, [path.join(fixtures, "wire.json")], ".")
      if (ran.exitCode !== 0) {
        problems.push(`The round trip, isolated to ${isolation} by default, failed:\n${ran.output}`)
      }
    }
    for (const problem of problems) {
      yield* Console.error(problem)
    }
    if (problems.length > 0) {
      return yield* new SwiftCheckFailed({ problems: problems.length })
    }
    yield* Console.log("The Swift clients compile in both isolations, and read and write what Effect's server does.")
  }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Compile the Swift clients openapi-swift writes, in both default isolations, and run their round trip.",
  ),
)
