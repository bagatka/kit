/**
 * A client of the App Store Connect API for following and publishing an app's releases, for any of
 * Apple's platforms: an app by its bundle ID, its builds, and its App Store versions; preparing a
 * version, submitting it for review, and releasing it; and its builds' TestFlight notes. Tokens are
 * signed with ES256 through Web Crypto.
 */
export type { AppStoreConnectCredentials, AppStoreConnectCrypto } from "./apple-api.ts"
export { AppStoreConnect } from "./app-store-connect.ts"
export {
  AppStoreConnectCredentialsInvalid,
  AppStoreConnectCredentialsRefused,
  AppStoreConnectForbidden,
  AppStoreConnectRefused,
  AppStoreConnectUnavailable,
} from "./errors.ts"
export { AppId, AppStoreVersionId, BuildId, Platform, ReviewSubmissionId } from "./ids.ts"
export type {
  App,
  AppStoreVersion,
  Build,
  LocalizedText,
  PreparedVersion,
  ReviewSubmission,
  VersionToSubmit,
} from "./resources.ts"
