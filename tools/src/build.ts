import { Console, Effect, FileSystem, Path, Schema } from "effect"
import { Argument, Command } from "effect/cli"

import { buildPackages } from "./build-packages.ts"

/** `bun run build` found problems, and printed them. */
export class PackagesNotBuilt extends Schema.TaggedError<PackagesNotBuilt>()("PackagesNotBuilt", {
  problems: Schema.Int,
}) {}

/**
 * `bun run build <folder>`: what npm gets of each package, built into a new folder, checked, and
 * listed in the order to publish them, one `<name>@<version> <tarball>` a line. The workflow that
 * publishes them reads that list (.github/workflows/publish.yml).
 */
export const build = Command.make(
  "build",
  {
    folder: Argument.String("folder").pipe(
      Argument.withDescription("A new or empty folder to build them in, such as build/."),
    ),
  },
  ({ folder }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const out = path.resolve(folder)
      yield* fs.makeDirectory(out, { recursive: true }).pipe(Effect.orDie)
      const entries = yield* fs.readDirectory(out).pipe(Effect.orDie)
      if (entries.length > 0) {
        yield* Console.error(`${folder} isn't empty. Give a new folder, so nothing left in it is published.`)
        return yield* new PackagesNotBuilt({ problems: 1 })
      }

      const built = yield* buildPackages(out)
      for (const problem of built.problems) {
        yield* Console.error(problem)
      }
      if (built.problems.length > 0) {
        const count = built.problems.length
        yield* Console.error(`\n${count === 1 ? "1 problem" : `${count} problems`}.`)
        return yield* new PackagesNotBuilt({ problems: count })
      }
      for (const builtPackage of built.packages) {
        yield* Console.log(`${builtPackage.name}@${builtPackage.version} ${builtPackage.tarball}`)
      }
    }),
).pipe(
  Command.withDescription(
    "Build the packages as npm gets them into a new folder, check that they install, and list them in the order to publish them.",
  ),
)
