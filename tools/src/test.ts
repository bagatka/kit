import { Console, Effect, Schema } from "effect"
import { Argument, Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** `bun run test` found failing tests, on the runtimes named. */
export class TestsFailed extends Schema.TaggedError<TestsFailed>()("TestsFailed", {
  runtimes: Schema.Array(Schema.String),
}) {}

// A time zone with a 45-minute offset and a locale with comma decimals and a dotless ı, so code that
// depends on the machine fails on every machine (PATTERNS.md, entry 2).
const unfriendly = { TZ: "Pacific/Chatham", LANG: "tr_TR.UTF-8" }

// The two engines the packages' callers run them on: V8 (Node, Cloudflare Workers, Chrome, Deno)
// and JavaScriptCore (Bun, Safari). Regular expressions, Web Crypto, and limits differ between them,
// so every test runs on both.
const runtimes = [
  { name: "Node (V8)", command: "node_modules/.bin/vitest", prefix: [] },
  { name: "Bun (JavaScriptCore)", command: "bun", prefix: ["--bun", "node_modules/.bin/vitest"] },
]

/** `bun run test [paths]`: every test, or those under `paths`, on Node and then on Bun. */
export const test = Command.make(
  "test",
  {
    paths: Argument.String("paths").pipe(
      Argument.withDescription("Folders or test files to run, such as packages/jwt; every test when none."),
      Argument.variadic(),
    ),
  },
  ({ paths }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const failed: Array<string> = []
      for (const runtime of runtimes) {
        yield* Console.log(`\nTests on ${runtime.name}`)
        const run = ChildProcess.make(runtime.command, [...runtime.prefix, "run", ...paths], {
          env: unfriendly,
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        })
        const exitCode = yield* spawner.spawn(run).pipe(
          Effect.flatMap((handle) => handle.exitCode),
          Effect.scoped,
          Effect.orDie,
        )
        if (exitCode !== 0) {
          failed.push(runtime.name)
        }
      }
      if (failed.length > 0) {
        yield* Console.error(`\nTests failed on ${failed.join(" and ")}.`)
        return yield* new TestsFailed({ runtimes: failed })
      }
    }),
).pipe(Command.withDescription("Run the tests on Node (V8) and on Bun (JavaScriptCore), in an unfriendly locale."))
