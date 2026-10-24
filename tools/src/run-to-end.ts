import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** Runs a program to its end; returns its exit code, what it printed, and its standard output alone. */
export const runToEnd = Effect.fn("runToEnd")(
  function* (command: string, args: ReadonlyArray<string>, cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, args, { cwd }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    )
    return { stdout, output: `${stdout}${stderr}`.trimEnd(), exitCode }
  },
  Effect.scoped,
  Effect.orDie,
)
