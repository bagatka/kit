import { Effect } from "effect"

import { findViolations } from "./find-violations.ts"
import { parseFolderPattern } from "./folder-pattern.ts"
import type { PackageRule } from "./package-rule.ts"
import { readWorkspace } from "./read-workspace.ts"

/**
 * Reads the workspace at `root` and returns every way its packages break `rules`, or the shape these
 * rules support, sorted by folder. An empty array means the workspace follows them. It reports
 * mistakes in your own repository; it isn't a defense against a hostile pull request.
 *
 * Reads the root `package.json`, the folders its patterns name, and each package's `package.json`,
 * each a regular file of at most 1 MiB; it follows no link and changes nothing. Time and memory are
 * linear in the size of each file it reads, and in the packages and their dependencies.
 *
 * Fails with `WorkspaceUnreadable` when the workspace can't be checked as a whole: a `package.json`
 * is missing, a link, not a regular file, too large, malformed, or repeats a key; a folder the root
 * names isn't a package; or the workspace uses a pattern these rules don't support. A rule with
 * such a pattern is a bug in the caller, and dies.
 */
export const checkWorkspace = Effect.fn("checkWorkspace")(function* (root: string, rules: ReadonlyArray<PackageRule>) {
  const patterns = rules.flatMap((rule) => [rule.folders, ...rule.mayUse])
  const invalid = patterns.filter((pattern) => parseFolderPattern(pattern)._tag === "None")
  if (invalid.length > 0) {
    return yield* Effect.die(`A PackageRule pattern isn't supported: ${invalid.join(", ")}`)
  }
  const workspace = yield* readWorkspace(root)
  return findViolations(workspace, rules)
})
