import { Schema } from "effect"

// The IDs of App Store Connect's resources, each a type of its own, so one can't be passed where
// another is asked for. Apple writes them as strings: an app's Apple ID in digits, the others as
// UUIDs. Each is one segment of a path, so `.`, `..` and anything an URL encodes are refused.

const appleId = Schema.String.check(Schema.isPattern(/^[0-9]{1,20}$/))
const resourceId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/))

/**
 * The ID of any resource in Apple's answers, such as a localization's: of the same shape, as each
 * goes into a path too.
 */
export const ResourceId = resourceId

/** An app's Apple ID, such as `1574205213`: digits. */
export const AppId = appleId.pipe(Schema.brand("AppId"))
export type AppId = typeof AppId.Type

/** A build's ID: letters, digits and `-`, as a UUID is. */
export const BuildId = resourceId.pipe(Schema.brand("BuildId"))
export type BuildId = typeof BuildId.Type

/** An App Store version's ID: letters, digits and `-`, as a UUID is. */
export const AppStoreVersionId = resourceId.pipe(Schema.brand("AppStoreVersionId"))
export type AppStoreVersionId = typeof AppStoreVersionId.Type

/** A review submission's ID: letters, digits and `-`, as a UUID is. */
export const ReviewSubmissionId = resourceId.pipe(Schema.brand("ReviewSubmissionId"))
export type ReviewSubmissionId = typeof ReviewSubmissionId.Type

/**
 * The platform an App Store version, a build, or a review submission is for, as Apple names it:
 * `IOS` (iPhone and iPad), `MAC_OS`, `TV_OS`, or `VISION_OS`.
 */
export const Platform = Schema.Literals(["IOS", "MAC_OS", "TV_OS", "VISION_OS"])
export type Platform = typeof Platform.Type
