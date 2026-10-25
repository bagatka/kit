import { Schema } from "effect"

/**
 * The credentials can't sign tokens App Store Connect takes: the key isn't a P-256 key in PKCS #8,
 * the key ID isn't 10 capital letters and digits, or the issuer ID isn't a UUID. `reason` says
 * which, never with the key in it. Building the client again won't help: fix the settings.
 */
export class AppStoreConnectCredentialsInvalid extends Schema.TaggedError<AppStoreConnectCredentialsInvalid>()(
  "AppStoreConnectCredentialsInvalid",
  { reason: Schema.String },
) {
  override get message(): string {
    return `The App Store Connect credentials were refused: ${this.reason}`
  }
}

/**
 * App Store Connect refused the key's token (401), a freshly signed one too: the key was revoked,
 * or the key ID or issuer ID isn't the key's. Every request fails so until the settings change, so
 * it is never about the request: fix the credentials. `reason` is Apple's error code and detail.
 */
export class AppStoreConnectCredentialsRefused extends Schema.TaggedError<AppStoreConnectCredentialsRefused>()(
  "AppStoreConnectCredentialsRefused",
  { reason: Schema.String },
) {
  override get message(): string {
    return `App Store Connect refused the credentials: ${this.reason}`
  }
}

/**
 * App Store Connect took the key but won't let it do this (403): its role doesn't allow it
 * (writing needs App Manager), or the team has a required agreement to accept
 * (`FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED`, which forbids every request until the
 * Account Holder accepts it in App Store Connect). Someone on the team must change the key's role
 * or accept the agreement; other requests of the key may still work. `reason` is Apple's error
 * code and detail.
 */
export class AppStoreConnectForbidden extends Schema.TaggedError<AppStoreConnectForbidden>()(
  "AppStoreConnectForbidden",
  { reason: Schema.String },
) {
  override get message(): string {
    return `App Store Connect forbade the request: ${this.reason}`
  }
}

/**
 * App Store Connect won't take the change in the current state (409), such as a build still
 * processing, a text over its limit, or a version that isn't pending release; or this client won't
 * make it, such as pausing a version without a phased release. Asking the same again won't help
 * until what `reason` names changes. `reason` is Apple's error code and detail, or says what was
 * refused.
 */
export class AppStoreConnectRefused extends Schema.TaggedError<AppStoreConnectRefused>()("AppStoreConnectRefused", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `App Store Connect refused the change: ${this.reason}`
  }
}

/**
 * App Store Connect didn't answer now: nothing within 15 seconds, too many requests (429, the
 * key's hourly limit), or a server error. Asking again later may work; a write may have been made
 * all the same, and every method is safe to call again.
 */
export class AppStoreConnectUnavailable extends Schema.TaggedError<AppStoreConnectUnavailable>()(
  "AppStoreConnectUnavailable",
  { reason: Schema.String },
) {
  override get message(): string {
    return `App Store Connect is unavailable: ${this.reason}`
  }
}

/** Every way a request of the client can fail. */
export type Failure =
  | AppStoreConnectCredentialsRefused
  | AppStoreConnectForbidden
  | AppStoreConnectRefused
  | AppStoreConnectUnavailable
