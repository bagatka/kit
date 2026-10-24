import { Schema } from "effect"

/**
 * The app's credentials can't sign the JWTs GitHub takes: the private key isn't an RSA key of 2048
 * to 8192 bits, in PKCS #1 as GitHub gives it or PKCS #8, or the app's ID isn't a number or a client
 * ID. `reason` says which, never with the key in it. Building the client again won't help: fix the
 * settings.
 */
export class GitHubAppCredentialsInvalid extends Schema.TaggedError<GitHubAppCredentialsInvalid>()(
  "GitHubAppCredentialsInvalid",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The GitHub App's credentials were refused: ${this.reason}`
  }
}

/**
 * GitHub refused: the app's JWT or a token is wrong or expired (401), lacks access (403), the app
 * isn't installed where asked or has no such installation (404), or GitHub won't take a manifest's
 * code (404, 422). `reason` is GitHub's message, or says what was refused. Sending again won't help.
 */
export class GitHubRefused extends Schema.TaggedError<GitHubRefused>()("GitHubRefused", {
  status: Schema.Int,
  reason: Schema.String,
}) {
  override get message(): string {
    return `GitHub refused (${this.status}): ${this.reason}`
  }
}

/**
 * GitHub didn't answer in 15 s, rate-limited the app (403 or 429), or failed (5xx): asking again
 * later may work. For a rate limit, `retryAfter` is when GitHub says to ask again, or a minute from
 * now when it doesn't say, as its documentation asks.
 */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()("GitHubUnavailable", {
  reason: Schema.String,
  retryAfter: Schema.optionalKey(Schema.DateTimeUtc),
}) {
  override get message(): string {
    return `GitHub is unavailable: ${this.reason}`
  }
}
