import { checkWorkspace } from "@bagatka/workspace-rules"
import { Console, Effect, FileSystem, Schema } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import { buildPackages } from "./build-packages.ts"
import { workspaceRules } from "./workspace-rules.ts"

/** `bun run check` found problems, and printed them. */
export class CheckFailed extends Schema.TaggedError<CheckFailed>()("CheckFailed", { problems: Schema.Int }) {}

// Comments that silence the compiler or the linter. A rule that is wrong for a case changes in its
// configuration file instead (AGENTS.md, "Let the compiler review first").
const suppression = "(oxlint|eslint)-(disable|enable)|@ts-(ignore|expect-error|nocheck)"

const findSuppressions = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  // Tracked and new files, not ignored ones; Markdown may mention the comments it forbids.
  return yield* spawner
    .lines(ChildProcess.make("git", ["grep", "-n", "-E", "--untracked", suppression, "--", ":!*.md"]))
    .pipe(Effect.orDie)
})

// Characters a reader can't see or a line can break on, which code writes as escapes instead: C1
// controls, the next-line, line and paragraph separators, zero-width spaces and marks, the byte
// order mark, and the replacement character. Each is a bug waiting in a string or a comment.
const invisible = /[\u0080-\u009f\u2028\u2029\u200b-\u200f\ufeff\ufffd]/

const findInvisible = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const fs = yield* FileSystem.FileSystem
  const files = yield* spawner
    .lines(ChildProcess.make("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts"]))
    .pipe(Effect.orDie)
  const found: Array<string> = []
  for (const file of files) {
    const text = yield* fs.readFileString(file).pipe(Effect.orDie)
    for (const [index, line] of text.split("\n").entries()) {
      if (invisible.test(line)) {
        found.push(`${file}:${index + 1}`)
      }
    }
  }
  return found
})

// What keeps a package from publishing, found by building them all as npm gets them, in a folder
// that is removed afterwards.
const unpublishable = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const folder = yield* fs.makeTempDirectoryScoped({ prefix: "bagatka-kit-" }).pipe(Effect.orDie)
  const built = yield* buildPackages(folder)
  return built.problems
}).pipe(Effect.scoped)

/**
 * What the compiler and the linter can't check: the workspace rules, suppressions, characters no
 * one can see, and whether the packages would publish, install, import, and type-check on each
 * platform.
 */
export const check = Command.make("check", {}, () =>
  Effect.gen(function* () {
    const violations = yield* checkWorkspace(".", workspaceRules)
    for (const violation of violations) {
      yield* Console.error(`${violation.folder}: ${violation.message}`)
    }
    const suppressions = yield* findSuppressions
    for (const line of suppressions) {
      yield* Console.error(`${line}: silences a check. Fix the code, or change the rule in its configuration file.`)
    }
    const invisibleCharacters = yield* findInvisible
    for (const line of invisibleCharacters) {
      yield* Console.error(`${line}: holds a character a reader can't see. Write it as an escape, such as \\u2028.`)
    }
    const packageProblems = yield* unpublishable
    for (const problem of packageProblems) {
      yield* Console.error(problem)
    }

    const problems = violations.length + suppressions.length + invisibleCharacters.length + packageProblems.length
    if (problems > 0) {
      yield* Console.error(`\n${problems === 1 ? "1 problem" : `${problems} problems`}.`)
      return yield* new CheckFailed({ problems })
    }
    yield* Console.log("Workspace rules, suppressions, characters, and npm packages are in order.")
  }),
).pipe(
  Command.withDescription(
    "Check the workspace rules and suppression comments, and that every package would publish to npm, install, import, and type-check in browsers and on Cloudflare Workers.",
  ),
)
