import { Schema } from "effect"

const repositoryRule =
  "an owner and a repository name joined by a slash, as GitHub names them, such as octocat/Hello-World: the owner 1 to 39 letters, digits or hyphens; the name 1 to 100 letters, digits, '.', '_' or '-', and not '.' or '..'"

/**
 * A repository, `owner/name`, as GitHub names it: `octocat/Hello-World`. A name of `.` or `..`,
 * which GitHub doesn't allow, is refused, so a repository is always one segment of a path.
 */
export const Repository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/, { expected: repositoryRule }),
).pipe(Schema.brand("Repository"))
export type Repository = typeof Repository.Type
