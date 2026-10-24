import { Schema } from "effect"

/** A GitHub App's name in URLs, such as `notes-releases`: letters, digits and `-`. */
export const AppSlug = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,100}$/)).pipe(Schema.brand("AppSlug"))
export type AppSlug = typeof AppSlug.Type
