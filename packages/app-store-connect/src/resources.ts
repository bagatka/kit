import type { DateTime } from "effect"
import { Array as Arr, Effect, Option, Order, Schema } from "effect"

import type { Platform } from "./ids.ts"
import { AppId, AppStoreVersionId, BuildId, ResourceId, ReviewSubmissionId } from "./ids.ts"

/** An app in App Store Connect: its Apple ID, its name on the App Store, and its bundle ID. */
export interface App {
  readonly id: AppId
  readonly name: string
  readonly bundleId: string
}

/** A build uploaded to App Store Connect, and where it is in TestFlight. */
export interface Build {
  readonly id: BuildId
  /** The platform it is for, such as `IOS` or `MAC_OS`, as Apple says it. */
  readonly platform: string
  /** Its marketing version, `CFBundleShortVersionString`, such as `2.4.0`. */
  readonly version: string
  /** Its build number, `CFBundleVersion`, such as `412`. */
  readonly buildNumber: string
  readonly uploadedAt: DateTime.Utc
  /** `PROCESSING`, `FAILED`, `INVALID`, or `VALID`, as Apple says it. */
  readonly processingState: string
  /** An expired build can no longer be tested. */
  readonly expired: boolean
  /** Its state for internal testers, such as `IN_BETA_TESTING`; absent when Apple gives none. */
  readonly internalTesting?: string
  /** Its state for external testers, such as `BETA_APPROVED`; absent when Apple gives none. */
  readonly externalTesting?: string
}

/** A version of an app on the App Store, from being prepared to being released. */
export interface AppStoreVersion {
  readonly id: AppStoreVersionId
  /** The platform it is for, such as `IOS` or `MAC_OS`, as Apple says it. */
  readonly platform: string
  /** Its version, such as `2.4.0`. */
  readonly version: string
  /** Where it is, such as `WAITING_FOR_REVIEW` or `READY_FOR_DISTRIBUTION`, as Apple says it. */
  readonly state: string
  /** `MANUAL`, `AFTER_APPROVAL`, or `SCHEDULED`; absent when Apple gives none. */
  readonly releaseType?: string
  /** When it was made in App Store Connect, not when it was released. */
  readonly createdAt: DateTime.Utc
  /** The earliest it may be released, for a scheduled release. */
  readonly earliestReleaseAt?: DateTime.Utc
  /** The build number of the build it ships; absent until one is chosen. */
  readonly buildNumber?: string
  /** Its release to users over 7 days; absent when it has none. */
  readonly phasedRelease?: {
    /** `INACTIVE`, `ACTIVE`, `PAUSED`, or `COMPLETE`, as Apple says it. */
    readonly state: string
    readonly startedAt?: DateTime.Utc
    /** Which day of the 7 it is on, from 1. */
    readonly currentDay?: number
  }
}

/** Text in one of the App Store's locales, such as `en-US` or `de-DE`. */
export interface LocalizedText {
  readonly locale: string
  readonly text: string
}

/** What `prepareVersion` makes of the app's editable App Store version for a platform. */
export interface VersionToSubmit {
  /** The platform it is for: the app's version for each platform is prepared on its own. */
  readonly platform: Platform
  /** Its version string, such as `2.5.0`: the build's marketing version. */
  readonly version: string
  /** The ID of the build it ships, a build for the same platform, which Apple has processed (`VALID`). */
  readonly buildId: BuildId
  /** `afterApproval` releases it as soon as App Review approves it; `manual` waits for `releaseVersion`. */
  readonly releaseType: "afterApproval" | "manual"
  /** Whether it is released over 7 days to the users with automatic updates on. */
  readonly phased: boolean
  /** Its What's New, up to 4,000 characters, in each locale it is written in. */
  readonly whatsNew: ReadonlyArray<LocalizedText>
}

/** The App Store version `prepareVersion` made ready to submit. */
export interface PreparedVersion {
  readonly versionId: AppStoreVersionId
  /** Its version string, such as `2.5.0`. */
  readonly version: string
  /** Where it is, such as `PREPARE_FOR_SUBMISSION`, as Apple says it. */
  readonly state: string
}

/** A submission to App Review. */
export interface ReviewSubmission {
  readonly submissionId: ReviewSubmissionId
  /** Where it is: `WAITING_FOR_REVIEW` once submitted, then `IN_REVIEW`, as Apple says it. */
  readonly state: string
}

// Apple's API is JSON:API: each resource has a type and an ID, its attributes, and relationships
// that name related resources, which `include` adds to the document's `included`. Attributes Apple
// leaves out or sends as null are both absent here; what this client needs is required, so an
// answer without it fails loudly. Every other field is ignored.

const Text = Schema.optionalKey(Schema.NullOr(Schema.String))
const Instant = Schema.optionalKey(Schema.NullOr(Schema.DateTimeUtcFromString))

// The type and ID of a related resource, as a relationship names it.
const Linkage = Schema.Struct({ type: Schema.String, id: ResourceId })
type Linkage = typeof Linkage.Type

// A relationship that `include` asked for, which may have no resource: an app version without a build.
const MaybeRelated = Schema.Struct({ data: Schema.optionalKey(Schema.NullOr(Linkage)) })

const AppResource = Schema.Struct({
  type: Schema.Literal("apps"),
  id: AppId,
  attributes: Schema.Struct({ name: Schema.String, bundleId: Schema.String }),
})

/** Apple's answer to `GET /v1/apps`. */
export const AppsDocument = Schema.Struct({ data: Schema.Array(AppResource) })

const BuildResource = Schema.Struct({
  type: Schema.Literal("builds"),
  id: BuildId,
  attributes: Schema.Struct({
    version: Schema.String,
    uploadedDate: Schema.DateTimeUtcFromString,
    processingState: Schema.String,
    expired: Schema.Boolean,
  }),
  relationships: Schema.Struct({
    // Every build belongs to a prerelease version, which holds its marketing version.
    preReleaseVersion: Schema.Struct({ data: Linkage }),
    buildBetaDetail: MaybeRelated,
  }),
})

const PreReleaseVersionResource = Schema.Struct({
  type: Schema.Literal("preReleaseVersions"),
  id: ResourceId,
  attributes: Schema.Struct({ version: Schema.String, platform: Schema.String }),
})

const BuildBetaDetailResource = Schema.Struct({
  type: Schema.Literal("buildBetaDetails"),
  id: ResourceId,
  attributes: Schema.Struct({ internalBuildState: Text, externalBuildState: Text }),
})

/** Apple's answer to `GET /v1/builds?include=preReleaseVersion,buildBetaDetail`. */
export const BuildsDocument = Schema.Struct({
  data: Schema.Array(BuildResource),
  included: Schema.optionalKey(Schema.Array(Schema.Union([PreReleaseVersionResource, BuildBetaDetailResource]))),
})
type BuildsDocument = typeof BuildsDocument.Type

const AppStoreVersionResource = Schema.Struct({
  type: Schema.Literal("appStoreVersions"),
  id: AppStoreVersionId,
  attributes: Schema.Struct({
    platform: Schema.String,
    versionString: Schema.String,
    appVersionState: Text,
    // Deprecated by Apple for `appVersionState`, which older answers may lack.
    appStoreState: Text,
    releaseType: Text,
    createdDate: Schema.DateTimeUtcFromString,
    earliestReleaseDate: Instant,
  }),
  relationships: Schema.Struct({ build: MaybeRelated, appStoreVersionPhasedRelease: MaybeRelated }),
})

const ShippedBuildResource = Schema.Struct({
  type: Schema.Literal("builds"),
  id: ResourceId,
  attributes: Schema.Struct({ version: Schema.String }),
})

const PhasedReleaseResource = Schema.Struct({
  type: Schema.Literal("appStoreVersionPhasedReleases"),
  id: ResourceId,
  attributes: Schema.Struct({
    phasedReleaseState: Schema.String,
    startDate: Instant,
    currentDayNumber: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  }),
})

/**
 * One page of Apple's answer to `GET /v1/apps/{id}/appStoreVersions?include=build,appStoreVersionPhasedRelease`;
 * its `links` are read where its pages are followed (`AppleApi.pages`).
 */
export const AppStoreVersionsDocument = Schema.Struct({
  data: Schema.Array(AppStoreVersionResource),
  included: Schema.optionalKey(Schema.Array(Schema.Union([ShippedBuildResource, PhasedReleaseResource]))),
})
type AppStoreVersionsDocument = typeof AppStoreVersionsDocument.Type

/** The answer's app with exactly this bundle ID, if any: Apple's filter isn't documented as exact. */
export const appOf = (document: typeof AppsDocument.Type, bundleId: string): Option.Option<App> =>
  Option.map(
    Arr.findFirst(document.data, (app) => app.attributes.bundleId === bundleId),
    (app) => ({ id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId }),
  )

/** The answer's builds, in its order, each with its marketing version and testing states. */
export const buildsOf = (document: BuildsDocument) =>
  Effect.forEach(document.data, (build) => buildOf(build, document.included ?? []))

/** The answer's versions, in its order, each with the build number it ships and its phased release. */
export const appStoreVersionsOf = (document: AppStoreVersionsDocument) =>
  Effect.forEach(document.data, (version) => appStoreVersionOf(version, document.included ?? []))

const buildOf = Effect.fnUntraced(function* (
  build: typeof BuildResource.Type,
  included: ReadonlyArray<typeof PreReleaseVersionResource.Type | typeof BuildBetaDetailResource.Type>,
) {
  const preReleaseVersion = yield* related(included, "preReleaseVersions", build.relationships.preReleaseVersion.data)
  const betaDetail = yield* maybeRelated(included, "buildBetaDetails", build.relationships.buildBetaDetail.data)
  const internalTesting = Option.getOrUndefined(betaDetail)?.attributes.internalBuildState ?? undefined
  const externalTesting = Option.getOrUndefined(betaDetail)?.attributes.externalBuildState ?? undefined
  const result: Build = {
    id: build.id,
    platform: preReleaseVersion.attributes.platform,
    version: preReleaseVersion.attributes.version,
    buildNumber: build.attributes.version,
    uploadedAt: build.attributes.uploadedDate,
    processingState: build.attributes.processingState,
    expired: build.attributes.expired,
    ...(internalTesting === undefined ? {} : { internalTesting }),
    ...(externalTesting === undefined ? {} : { externalTesting }),
  }
  return result
})

const appStoreVersionOf = Effect.fnUntraced(function* (
  version: typeof AppStoreVersionResource.Type,
  included: ReadonlyArray<typeof ShippedBuildResource.Type | typeof PhasedReleaseResource.Type>,
) {
  const attributes = version.attributes
  const state = yield* stateOf(version)
  const build = yield* maybeRelated(included, "builds", version.relationships.build.data)
  const phased = yield* maybeRelated(
    included,
    "appStoreVersionPhasedReleases",
    version.relationships.appStoreVersionPhasedRelease.data,
  )
  const releaseType = attributes.releaseType ?? undefined
  const earliestReleaseAt = attributes.earliestReleaseDate ?? undefined
  const result: AppStoreVersion = {
    id: version.id,
    platform: attributes.platform,
    version: attributes.versionString,
    state,
    createdAt: attributes.createdDate,
    ...(releaseType === undefined ? {} : { releaseType }),
    ...(earliestReleaseAt === undefined ? {} : { earliestReleaseAt }),
    ...(Option.isSome(build) ? { buildNumber: build.value.attributes.version } : {}),
    ...(Option.isSome(phased) ? { phasedRelease: phasedReleaseOf(phased.value) } : {}),
  }
  return result
})

const phasedReleaseOf = (phased: typeof PhasedReleaseResource.Type): NonNullable<AppStoreVersion["phasedRelease"]> => {
  const startedAt = phased.attributes.startDate ?? undefined
  const currentDay = phased.attributes.currentDayNumber ?? undefined
  return {
    state: phased.attributes.phasedReleaseState,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(currentDay === undefined ? {} : { currentDay }),
  }
}

// The included resource a relationship names. A document that names one without including it, though
// `include` asked for it, isn't one this client can read.
const related = <R extends Linkage, T extends R["type"]>(
  included: ReadonlyArray<R>,
  type: T,
  linkage: Linkage,
): Effect.Effect<Extract<R, { readonly type: T }>> => {
  const found = Arr.findFirst(
    included,
    (resource): resource is Extract<R, { readonly type: T }> => resource.type === type && resource.id === linkage.id,
  )
  if (Option.isNone(found)) {
    return Effect.die(
      `App Store Connect's answer relates ${linkage.type} ${linkage.id}, which it doesn't include among its ${type}`,
    )
  }
  return Effect.succeed(found.value)
}

// The included resource a relationship names, or none when it names none.
const maybeRelated = <R extends Linkage, T extends R["type"]>(
  included: ReadonlyArray<R>,
  type: T,
  linkage: Linkage | null | undefined,
): Effect.Effect<Option.Option<Extract<R, { readonly type: T }>>> => {
  if (linkage === null || linkage === undefined) {
    return Effect.succeedNone
  }
  return Effect.asSome(related(included, type, linkage))
}

// A version's state: `appVersionState`, or `appStoreState`, which Apple deprecated for it and older
// answers carry alone. Every version has one, so an answer without either isn't one this client reads.
const stateOf = (version: {
  readonly id: string
  readonly attributes: { readonly appVersionState?: string | null; readonly appStoreState?: string | null }
}): Effect.Effect<string> => {
  const state = version.attributes.appVersionState ?? version.attributes.appStoreState ?? undefined
  return state === undefined
    ? Effect.die(`App Store Connect gave App Store version ${version.id} no state`)
    : Effect.succeed(state)
}

// What preparing a version needs of each: the IDs of its build and phased release, which the
// contract's `AppStoreVersion` leaves out.

/** An App Store version, with the IDs of its build and its phased release, if it has them. */
export interface VersionDraft {
  readonly id: AppStoreVersionId
  readonly version: string
  readonly state: string
  /** `MANUAL`, `AFTER_APPROVAL`, or `SCHEDULED`; absent when Apple gives none. */
  readonly releaseType?: string
  readonly createdAt: DateTime.Utc
  readonly buildId?: string
  readonly phasedReleaseId?: string
}

/** The page's versions, in its order, with the IDs of their builds and phased releases. */
export const versionDraftsOf = (document: AppStoreVersionsDocument) =>
  Effect.forEach(document.data, (version) =>
    Effect.map(stateOf(version), (state): VersionDraft => {
      const releaseType = version.attributes.releaseType ?? undefined
      const buildId = version.relationships.build.data?.id
      const phasedReleaseId = version.relationships.appStoreVersionPhasedRelease.data?.id
      return {
        id: version.id,
        version: version.attributes.versionString,
        state,
        createdAt: version.attributes.createdDate,
        ...(releaseType === undefined ? {} : { releaseType }),
        ...(buildId === undefined ? {} : { buildId }),
        ...(phasedReleaseId === undefined ? {} : { phasedReleaseId }),
      }
    }),
  )

// One App Store version, as Apple answers a write to it or a read of it. Apple's example answer to
// making one carries `appStoreState` alone and no `createdDate`, so only what every answer has is
// required.
const VersionResource = Schema.Struct({
  type: Schema.Literal("appStoreVersions"),
  id: AppStoreVersionId,
  attributes: Schema.Struct({ versionString: Schema.String, appVersionState: Text, appStoreState: Text }),
  relationships: Schema.optionalKey(Schema.Struct({ appStoreVersionPhasedRelease: Schema.optionalKey(MaybeRelated) })),
})

/**
 * Apple's answer to `POST /v1/appStoreVersions`, `PATCH /v1/appStoreVersions/{id}`, and
 * `GET /v1/appStoreVersions/{id}?include=appStoreVersionPhasedRelease`.
 */
export const AppStoreVersionDocument = Schema.Struct({
  data: VersionResource,
  included: Schema.optionalKey(Schema.Array(PhasedReleaseResource)),
})
type AppStoreVersionDocument = typeof AppStoreVersionDocument.Type

/** The answer's version: its ID, version string, and state. */
export const preparedVersionOf = (document: AppStoreVersionDocument): Effect.Effect<PreparedVersion> =>
  Effect.map(stateOf(document.data), (state) => ({
    versionId: document.data.id,
    version: document.data.attributes.versionString,
    state,
  }))

/** The answer's version's phased release, by its ID and state; none when it has none. */
export const versionPhasedReleaseOf = (document: AppStoreVersionDocument) =>
  Effect.map(
    maybeRelated(
      document.included ?? [],
      "appStoreVersionPhasedReleases",
      document.data.relationships?.appStoreVersionPhasedRelease?.data,
    ),
    (phased) => Option.map(phased, (found) => ({ id: found.id, state: found.attributes.phasedReleaseState })),
  )

const AppInfoResource = Schema.Struct({
  type: Schema.Literal("appInfos"),
  id: ResourceId,
  // `appStoreState` is deprecated for `state`; Apple's example answer carries it alone.
  attributes: Schema.Struct({ state: Text, appStoreState: Text }),
  relationships: Schema.Struct({ appInfoLocalizations: Schema.Struct({ data: Schema.Array(Linkage) }) }),
})

const AppInfoLocalizationResource = Schema.Struct({
  type: Schema.Literal("appInfoLocalizations"),
  id: ResourceId,
  attributes: Schema.Struct({ locale: Schema.String }),
})

const PrimaryLocaleResource = Schema.Struct({
  type: Schema.Literal("apps"),
  id: AppId,
  attributes: Schema.Struct({ primaryLocale: Schema.String }),
})

/** Apple's answer to `GET /v1/apps/{id}/appInfos?include=app,appInfoLocalizations`. */
export const AppInfosDocument = Schema.Struct({
  data: Schema.Array(AppInfoResource),
  included: Schema.optionalKey(Schema.Array(Schema.Union([PrimaryLocaleResource, AppInfoLocalizationResource]))),
})
type AppInfosDocument = typeof AppInfosDocument.Type

// An app's information is live in these states; while a version is prepared, it has another app
// info for it, in another state, whose locales are the ones that version is released with.
const liveInfoStates: ReadonlySet<string> = new Set([
  "READY_FOR_DISTRIBUTION",
  "REPLACED_WITH_NEW_INFO",
  "READY_FOR_SALE",
  "REPLACED_WITH_NEW_VERSION",
  "DEVELOPER_REMOVED_FROM_SALE",
  "REMOVED_FROM_SALE",
])

/**
 * The locales of the app's information for its next version, or of its live one when none is
 * prepared: its primary locale first, then the others in code-point order.
 */
export const appLocalesOf = Effect.fnUntraced(function* (document: AppInfosDocument, appId: string) {
  const included = document.included ?? []
  const next = Arr.findFirst(document.data, (info) => {
    const state = info.attributes.state ?? info.attributes.appStoreState ?? undefined
    return state === undefined || !liveInfoStates.has(state)
  })
  const info = Option.orElse(next, () => Arr.head(document.data))
  if (Option.isNone(info)) {
    return yield* Effect.die(`App Store Connect gave app ${appId} no app info`)
  }
  const localizations = yield* Effect.forEach(info.value.relationships.appInfoLocalizations.data, (linkage) =>
    related(included, "appInfoLocalizations", linkage),
  )
  const app = yield* related(included, "apps", { type: "apps", id: appId })
  const primary = app.attributes.primaryLocale
  const others = Arr.sort(
    localizations.map((localization) => localization.attributes.locale).filter((locale) => locale !== primary),
    Order.String,
  )
  const hasPrimary = localizations.some((localization) => localization.attributes.locale === primary)
  return hasPrimary ? [primary, ...others] : others
})

// A text in one locale of something Apple localizes: an App Store version's What's New, or a
// build's What to Test.
const localizationsDocument = <T extends string>(type: T) =>
  Schema.Struct({
    data: Schema.Array(
      Schema.Struct({
        type: Schema.Literal(type),
        id: ResourceId,
        attributes: Schema.Struct({ locale: Schema.String, whatsNew: Text }),
      }),
    ),
  })

/** Apple's answer to `GET /v1/appStoreVersions/{id}/appStoreVersionLocalizations`. */
export const VersionLocalizationsDocument = localizationsDocument("appStoreVersionLocalizations")

/** Apple's answer to `GET /v1/builds/{id}/betaBuildLocalizations`. */
export const BetaBuildLocalizationsDocument = localizationsDocument("betaBuildLocalizations")

/** One locale's text of something Apple localizes, by the ID of its localization. */
export interface Localization {
  readonly id: string
  readonly locale: string
  /** Absent while it has none. */
  readonly text?: string
}

/** The answer's localizations, with their What's New or What to Test. */
export const localizationsOf = (document: {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly attributes: { readonly locale: string; readonly whatsNew?: string | null }
  }>
}): ReadonlyArray<Localization> =>
  document.data.map((localization) => {
    const text = localization.attributes.whatsNew ?? undefined
    return {
      id: localization.id,
      locale: localization.attributes.locale,
      ...(text === undefined ? {} : { text }),
    }
  })

const ReviewSubmissionResource = Schema.Struct({
  type: Schema.Literal("reviewSubmissions"),
  id: ReviewSubmissionId,
  attributes: Schema.Struct({ state: Schema.String }),
})

/** Apple's answer to `GET /v1/reviewSubmissions`. */
export const ReviewSubmissionsDocument = Schema.Struct({ data: Schema.Array(ReviewSubmissionResource) })

/** Apple's answer to `POST /v1/reviewSubmissions` and `PATCH /v1/reviewSubmissions/{id}`. */
export const ReviewSubmissionDocument = Schema.Struct({ data: ReviewSubmissionResource })

/** The answer's submission. */
export const reviewSubmissionOf = (document: typeof ReviewSubmissionDocument.Type): ReviewSubmission => ({
  submissionId: document.data.id,
  state: document.data.attributes.state,
})

const ReviewSubmissionItemResource = Schema.Struct({
  type: Schema.Literal("reviewSubmissionItems"),
  id: ResourceId,
  attributes: Schema.Struct({ state: Text }),
  // An item holds one thing to review: an App Store version, or another kind, such as an in-app event.
  relationships: Schema.optionalKey(Schema.Struct({ appStoreVersion: Schema.optionalKey(MaybeRelated) })),
})

/** Apple's answer to `GET /v1/reviewSubmissions/{id}/items?include=appStoreVersion`. */
export const ReviewSubmissionItemsDocument = Schema.Struct({ data: Schema.Array(ReviewSubmissionItemResource) })

/** The answer's item holding the App Store version, with its state; none when no item holds it. */
export const versionItemOf = (document: typeof ReviewSubmissionItemsDocument.Type, versionId: string) =>
  Option.map(
    Arr.findFirst(document.data, (item) => item.relationships?.appStoreVersion?.data?.id === versionId),
    (item) => ({ id: item.id, state: item.attributes.state ?? undefined }),
  )
