import { Schema } from "effect"

/** One way a package breaks its rule. */
export class Violation extends Schema.Class<Violation>("Violation")({
  /**
   * The package's folder relative to the workspace root, or `.` for the root `package.json`: a
   * supported folder name, so safe to print at the start of a line.
   */
  folder: Schema.String,
  /**
   * What the violation is about: `unsupported` is something these rules don't support, such as
   * `overrides`, a link, or a folder name outside the supported shape, which must go.
   */
  check: Schema.Literals(["rule", "name", "contract", "dependency", "version", "cycle", "unsupported"]),
  /**
   * What is wrong and how to fix it, written for a person. Text taken from a `package.json` or a
   * folder's listing is quoted, with everything outside printable ASCII escaped.
   */
  message: Schema.String,
}) {}
