import { Schema } from "effect"

/**
 * A GitHub App's installation on an account, by GitHub's number for it, such as `42`: what
 * `installations` lists, and the `installation_id` GitHub adds to the app's setup URL, which anyone
 * can forge, so check one from there with `installations` or `installationOf` before trusting it.
 */
export const InstallationId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("InstallationId"))
export type InstallationId = typeof InstallationId.Type
