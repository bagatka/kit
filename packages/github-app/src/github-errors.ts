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

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * GitHub refused the app's JWT (401), one signed again too: the private key was revoked or deleted,
 * or the app's ID isn't the key's app. Every request fails so until the settings change. `reason` is
 * GitHub's message.
 */
export class GitHubAppCredentialsRefused extends Schema.TaggedError<GitHubAppCredentialsRefused>()(
  "GitHubAppCredentialsRefused",
  { reason: Schema.String },
) {
  override get message(): string {
    return `GitHub refused the GitHub App's credentials: ${this.reason}`
  }

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * GitHub took the credentials but won't let them do this (403, not a rate limit): the installation
 * is suspended, or lacks the permission. Someone with access to the app or the installation must
 * change it. `reason` is GitHub's message.
 */
export class GitHubForbidden extends Schema.TaggedError<GitHubForbidden>()("GitHubForbidden", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `GitHub forbade the request: ${this.reason}`
  }

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * GitHub won't do this as things are: the app isn't installed where asked, or has no such
 * installation, the installation doesn't reach the repository, or a manifest's code is unknown,
 * used, or can't be converted. Asking again won't help until what `reason` names changes. `reason`
 * is GitHub's message, or says what was refused.
 */
export class GitHubRefused extends Schema.TaggedError<GitHubRefused>()("GitHubRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `GitHub refused: ${this.reason}`
  }

  /** Asking again won't help. */
  get isRetryable(): boolean {
    return false
  }
}

/**
 * GitHub didn't answer in 15 seconds, rate-limited the app (403 or 429), or failed (5xx): asking
 * again later may work. For a rate limit, `retryAfter` is how long GitHub says to wait, or a minute
 * when it doesn't say, as its documentation asks.
 */
export class GitHubUnavailable extends Schema.TaggedError<GitHubUnavailable>()("GitHubUnavailable", {
  reason: Schema.String,
  retryAfter: Schema.optionalKey(Schema.Duration),
}) {
  override get message(): string {
    return `GitHub is unavailable: ${this.reason}`
  }

  /** Asking again later may work. */
  get isRetryable(): boolean {
    return true
  }
}

/** Every way a request to GitHub can fail. */
export type Failure = GitHubAppCredentialsRefused | GitHubForbidden | GitHubRefused | GitHubUnavailable
