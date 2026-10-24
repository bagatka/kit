import { Schema } from "effect"

import { AppSlug } from "./app-slug.ts"
import { InstallationId } from "./installation-id.ts"
import { Repository } from "./repository.ts"

// The parts of GitHub's JSON this package reads, as its REST API's description defines them
// (github/rest-api-description, `api.github.com.json`, API version 2022-11-28). Fields it doesn't
// read are ignored; a field it reads that is missing or of another type fails the decoding.

/**
 * A GitHub App's installation, as `GET /repos/{owner}/{repo}/installation` answers it and
 * `GET /app/installations` lists it.
 */
export const InstallationAnswer = Schema.Struct({
  id: InstallationId,
  // Not handled: an installation on an enterprise account, whose account has a slug and no login,
  // or none at all, as GitHub's description allows; it dies as an answer of another shape. Handling
  // it would take an account type of its own.
  account: Schema.Struct({ login: Schema.String }),
  target_type: Schema.Literals(["User", "Organization"]),
  repository_selection: Schema.Literals(["all", "selected"]),
  html_url: Schema.String,
})
export type InstallationAnswer = typeof InstallationAnswer.Type

/** `GET /app/installations`: one page of the app's installations. */
export const InstallationsAnswer = Schema.Array(InstallationAnswer)

/** `GET /installation/repositories`: one page of the repositories an installation reaches. */
export const InstallationRepositoriesAnswer = Schema.Struct({
  repositories: Schema.Array(Schema.Struct({ full_name: Repository })),
})

/** `POST /app/installations/{installation_id}/access_tokens`, answered 201: a token, redacted when read. */
export const InstallationTokenAnswer = Schema.Struct({
  token: Schema.RedactedFromValue(Schema.String),
  expires_at: Schema.DateTimeUtcFromString,
})

/**
 * `POST /app-manifests/{code}/conversions`, answered 201: the app GitHub created, with its secrets,
 * redacted when read. `slug`, optional in GitHub's description of an app, is always in this answer.
 */
export const ManifestConversionAnswer = Schema.Struct({
  id: Schema.Int,
  slug: AppSlug,
  name: Schema.String,
  html_url: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.RedactedFromValue(Schema.String),
  webhook_secret: Schema.NullOr(Schema.RedactedFromValue(Schema.String)),
  pem: Schema.RedactedFromValue(Schema.String),
})
export type ManifestConversionAnswer = typeof ManifestConversionAnswer.Type

/** What GitHub says when it doesn't answer what was asked: `{ "message": "Bad credentials", ... }`. */
export const ErrorAnswer = Schema.fromJsonString(Schema.Struct({ message: Schema.String }))

/**
 * The headers GitHub says a rate limit with: `retry-after`, in seconds as GitHub writes it or an
 * HTTP date, as HTTP allows; the requests left in the window, and when it resets, in Unix seconds.
 */
export const RateLimitHeaders = Schema.Struct({
  "retry-after": Schema.optionalKey(Schema.RetryAfterFromString),
  "x-ratelimit-remaining": Schema.optionalKey(Schema.String),
  "x-ratelimit-reset": Schema.optionalKey(Schema.NumberFromString.check(Schema.isInt())),
})
