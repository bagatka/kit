/**
 * Checks a JavaScript workspace against rules: what each package is named, whether other packages
 * may import it, and which packages it may depend on, at which versions.
 */
export { checkWorkspace } from "./check-workspace.ts"
export type { PackageRule } from "./package-rule.ts"
export { Violation } from "./violation.ts"
export { WorkspaceUnreadable } from "./workspace-unreadable.ts"
