import { Schema } from "effect"

/**
 * The workspace can't be checked: a `package.json` is missing, a link, not a regular file of at
 * most 1 MiB, not valid JSON, repeats a key, or has fields of the wrong type; a folder the root
 * names isn't a package; or the workspace uses a pattern these rules don't support. Nothing was
 * reported, so nothing passed: fix what `reason` says and run the check again.
 */
export class WorkspaceUnreadable extends Schema.TaggedError<WorkspaceUnreadable>()("WorkspaceUnreadable", {
  /** The file or folder, relative to the workspace root and written with `/`. */
  path: Schema.String,
  /** What is wrong with it, with any text taken from the workspace quoted and escaped. */
  reason: Schema.String,
}) {
  /** `<path>: <reason>`, so a log or `Cause.pretty` says what is wrong. */
  override get message(): string {
    return `${this.path}: ${this.reason}`
  }
}
