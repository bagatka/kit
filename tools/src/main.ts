import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect } from "effect"
import { Command } from "effect/cli"

import { build } from "./build.ts"
import { check } from "./check.ts"
import { swift } from "./swift.ts"
import { test } from "./test.ts"

/**
 * The repository's program: `bun run check`, `bun run check:swift`, `bun run test` and `bun run build` call
 * it from the repository's root.
 */
const kit = Command.make("kit").pipe(
  Command.withDescription(
    "Check this repository and its Swift, run its tests on both engines, and build its packages as npm gets them.",
  ),
  Command.withSubcommands([check, test, build, swift]),
)

const program = kit.pipe(
  Command.run({ version: "unreleased" }),
  // An expected failure has already printed what went wrong and exits with code 1. A defect is a
  // bug, and prints in full.
  Effect.tapCause((cause) => (Cause.hasDies(cause) ? Effect.logError(cause) : Effect.void)),
  Effect.provide(BunServices.layer),
)

BunRuntime.runMain(program, { disableErrorReporting: true })
