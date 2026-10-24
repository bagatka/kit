import { Array as Arr, DateTime, Effect, Option, Order } from "effect"

import type { AppleApi } from "./apple-api.ts"
import { decoded, pageSize } from "./apple-api.ts"
import { AppStoreConnectRefused } from "./errors.ts"
import type { AppId, AppStoreVersionId, BuildId, Platform, ReviewSubmissionId } from "./ids.ts"
import type { Localization, LocalizedText, VersionDraft, VersionToSubmit } from "./resources.ts"
import {
  AppStoreVersionDocument,
  AppStoreVersionsDocument,
  BetaBuildLocalizationsDocument,
  ReviewSubmissionDocument,
  ReviewSubmissionItemsDocument,
  ReviewSubmissionsDocument,
  VersionLocalizationsDocument,
  localizationsOf,
  preparedVersionOf,
  reviewSubmissionOf,
  versionDraftsOf,
  versionItemOf,
  versionPhasedReleaseOf,
} from "./resources.ts"

// Publishing an app's version for a platform on the App Store, step by step as Apple's API takes it. Each step reads what
// Apple has first and writes only what differs, so calling a method again after a refusal or an
// outage part-way finishes what was left, and repeats nothing.

// The states of a version that is being prepared, or was rejected or removed from review, whose
// build and metadata can change before it is submitted (App Store Connect Help, "App and
// submission statuses"). Apple allows one such version per platform.
const editableStates: ReadonlySet<string> = new Set([
  "PREPARE_FOR_SUBMISSION",
  "READY_FOR_REVIEW",
  "INVALID_BINARY",
  "REJECTED",
  "METADATA_REJECTED",
  "DEVELOPER_REJECTED",
])

// The states of a version released, or being processed for release; with `appStoreState`'s names
// for older answers.
const releasedStates: ReadonlySet<string> = new Set([
  "PROCESSING_FOR_DISTRIBUTION",
  "READY_FOR_DISTRIBUTION",
  "REPLACED_WITH_NEW_VERSION",
  "PROCESSING_FOR_APP_STORE",
  "READY_FOR_SALE",
])

// The submissions that may hold a version: a draft, one submitted, or one App Review rejected.
const openSubmissionStates = "READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES"

const appleReleaseType = { afterApproval: "AFTER_APPROVAL", manual: "MANUAL" } as const

const phasedReleaseState = { pause: "PAUSED", resume: "ACTIVE", complete: "COMPLETE" } as const

const latestCreatedFirst = Order.flip(Order.mapInput(DateTime.Order, (version: VersionDraft) => version.createdAt))

// What a localized text is written on: Apple's type of localization, and the resource it localizes.
interface Localized {
  readonly type: "appStoreVersionLocalizations" | "betaBuildLocalizations"
  readonly owner: {
    readonly relationship: "appStoreVersion" | "build"
    readonly type: "appStoreVersions" | "builds"
    readonly id: string
  }
}

// The version being prepared, as Apple last said it, with the IDs of its build and phased release.
interface Preparing {
  readonly id: AppStoreVersionId
  readonly version: string
  readonly state: string
  readonly buildId?: string
  readonly phasedReleaseId?: string
}

const enc = encodeURIComponent

/** The methods that change an app's App Store versions, its review submissions, and its builds' test notes. */
export const publishing = (api: AppleApi) => {
  const prepareVersion = Effect.fn("AppStoreConnect.prepareVersion")(function* (
    appId: AppId,
    request: VersionToSubmit,
  ) {
    yield* checkLocales(request.whatsNew, "What's New")
    const texts = yield* api.pages(
      `/v1/apps/${enc(appId)}/appStoreVersions`,
      { "filter[platform]": request.platform, include: "build,appStoreVersionPhasedRelease", limit: pageSize },
      "App Store versions",
    )
    const pages = yield* Effect.forEach(texts, (text) =>
      decoded(AppStoreVersionsDocument, text, "App Store versions").pipe(Effect.flatMap(versionDraftsOf)),
    )
    const versions = Arr.flatten(pages)
    // Not handled: two editable versions, which Apple doesn't allow; the latest made is prepared.
    const editable = Arr.head(
      Arr.sort(
        versions.filter((version) => editableStates.has(version.state)),
        latestCreatedFirst,
      ),
    )
    // An app with no version for the platform but this one has never been on the App Store there.
    // Apple takes no What's New for its first version, and has no phased release for it: there are
    // no users to update.
    const firstVersion = versions.every((version) => Option.isSome(editable) && version.id === editable.value.id)
    const draft = yield* versionFor(appId, editable, request)
    yield* attachBuild(draft, request.buildId)
    yield* setPhased(draft, request.phased && !firstVersion)
    if (!firstVersion) {
      yield* writeWhatsNew(draft.id, request.whatsNew)
    }
    return { versionId: draft.id, version: draft.version, state: draft.state }
  })

  // The editable version with the request's version string and release type: changed where they
  // differ, or a version made with them when the app has none.
  const versionFor = Effect.fn("AppStoreConnect.versionFor")(function* (
    appId: AppId,
    editable: Option.Option<VersionDraft>,
    request: VersionToSubmit,
  ) {
    const releaseType = appleReleaseType[request.releaseType]
    if (Option.isNone(editable)) {
      const text = yield* api.send("POST", "/v1/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: request.platform, versionString: request.version, releaseType },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      })
      const created = yield* decoded(AppStoreVersionDocument, text, "the App Store version made")
      const made = yield* preparedVersionOf(created)
      const preparing: Preparing = { id: made.versionId, version: made.version, state: made.state }
      return preparing
    }
    const draft = editable.value
    const sameVersion = draft.version === request.version
    const sameReleaseType = draft.releaseType === releaseType
    if (sameVersion && sameReleaseType) {
      const preparing: Preparing = draft
      return preparing
    }
    const text = yield* api.send("PATCH", `/v1/appStoreVersions/${enc(draft.id)}`, {
      data: {
        type: "appStoreVersions",
        id: draft.id,
        attributes: {
          ...(sameVersion ? {} : { versionString: request.version }),
          ...(sameReleaseType ? {} : { releaseType }),
        },
      },
    })
    const changed = yield* decoded(AppStoreVersionDocument, text, "the App Store version changed")
    const current = yield* preparedVersionOf(changed)
    const updated: Preparing = { ...draft, version: current.version, state: current.state }
    return updated
  })

  // After the version string: Apple takes a build only for the version it was built as.
  const attachBuild = Effect.fn("AppStoreConnect.attachBuild")(function* (draft: Preparing, buildId: BuildId) {
    if (draft.buildId === buildId) {
      return
    }
    yield* api.send("PATCH", `/v1/appStoreVersions/${enc(draft.id)}/relationships/build`, {
      data: { type: "builds", id: buildId },
    })
  })

  // A phased release made for a version that should have one, or removed from one that shouldn't;
  // before release it is `INACTIVE`, and removing it cancels it.
  const setPhased = Effect.fn("AppStoreConnect.setPhased")(function* (draft: Preparing, phased: boolean) {
    const phasedReleaseId = draft.phasedReleaseId
    if (phased && phasedReleaseId === undefined) {
      yield* api.send("POST", "/v1/appStoreVersionPhasedReleases", {
        data: {
          type: "appStoreVersionPhasedReleases",
          attributes: { phasedReleaseState: "INACTIVE" },
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: draft.id } } },
        },
      })
      return
    }
    if (!phased && phasedReleaseId !== undefined) {
      yield* api.send("DELETE", `/v1/appStoreVersionPhasedReleases/${enc(phasedReleaseId)}`)
    }
  })

  const writeWhatsNew = Effect.fn("AppStoreConnect.writeWhatsNew")(function* (
    versionId: AppStoreVersionId,
    notes: ReadonlyArray<LocalizedText>,
  ) {
    if (notes.length === 0) {
      return
    }
    const text = yield* api.get(`/v1/appStoreVersions/${enc(versionId)}/appStoreVersionLocalizations`, {
      "fields[appStoreVersionLocalizations]": "locale,whatsNew",
      limit: pageSize,
    })
    const document = yield* decoded(VersionLocalizationsDocument, text, "App Store version localizations")
    const localized: Localized = {
      type: "appStoreVersionLocalizations",
      owner: { relationship: "appStoreVersion", type: "appStoreVersions", id: versionId },
    }
    const existing = localizationsOf(document)
    yield* Effect.forEach(notes, (note) => writeLocalized(localized, existing, note), { discard: true })
  })

  // One locale's text: changed where it differs, made where there's none.
  const writeLocalized = Effect.fn("AppStoreConnect.writeLocalized")(function* (
    localized: Localized,
    existing: ReadonlyArray<Localization>,
    note: LocalizedText,
  ) {
    const current = Arr.findFirst(existing, (localization) => localization.locale === note.locale)
    if (Option.isNone(current)) {
      yield* api.send("POST", `/v1/${localized.type}`, {
        data: {
          type: localized.type,
          attributes: { locale: note.locale, whatsNew: note.text },
          relationships: {
            [localized.owner.relationship]: { data: { type: localized.owner.type, id: localized.owner.id } },
          },
        },
      })
      return
    }
    if (current.value.text === note.text) {
      return
    }
    yield* api.send("PATCH", `/v1/${localized.type}/${enc(current.value.id)}`, {
      data: { type: localized.type, id: current.value.id, attributes: { whatsNew: note.text } },
    })
  })

  const submitForReview = Effect.fn("AppStoreConnect.submitForReview")(function* (
    appId: AppId,
    platform: Platform,
    versionId: AppStoreVersionId,
  ) {
    const text = yield* api.get("/v1/reviewSubmissions", {
      "filter[app]": appId,
      "filter[platform]": platform,
      "filter[state]": openSubmissionStates,
      limit: pageSize,
    })
    const open = yield* decoded(ReviewSubmissionsDocument, text, "review submissions")
    const holding = yield* Effect.forEach(open.data, (submission) =>
      Effect.map(itemOf(submission.id, versionId), (item) =>
        Option.map(item, (found) => ({ submission: reviewSubmissionOf({ data: submission }), item: found })),
      ),
    )
    const held = Arr.head(Arr.getSomes(holding))
    if (Option.isSome(held)) {
      return yield* resubmit(held.value.submission, held.value.item)
    }
    const draft = Arr.findFirst(open.data, (submission) => submission.attributes.state === "READY_FOR_REVIEW")
    const submissionId = yield* draftOf(appId, platform, draft)
    yield* api.send("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    })
    return yield* submit(submissionId)
  })

  // The submission's item holding the version, unless it was removed from it: Apple doesn't take a
  // removed item back into the same submission.
  const itemOf = Effect.fn("AppStoreConnect.itemOf")(function* (
    submissionId: ReviewSubmissionId,
    versionId: AppStoreVersionId,
  ) {
    const text = yield* api.get(`/v1/reviewSubmissions/${enc(submissionId)}/items`, {
      include: "appStoreVersion",
      limit: pageSize,
    })
    const items = yield* decoded(ReviewSubmissionItemsDocument, text, "review submission items")
    return Option.filter(versionItemOf(items, versionId), (item) => item.state !== "REMOVED")
  })

  // A submission already holding the version: left as it is once submitted, and submitted
  // otherwise. In one App Review rejected (`UNRESOLVED_ISSUES`), the version's rejected item is first
  // marked `resolved`, the attribute Apple's API has for an item edited after a rejection; Apple
  // documents nothing more of it, and refuses with its detail if it wants otherwise.
  const resubmit = Effect.fn("AppStoreConnect.resubmit")(function* (
    submission: { readonly submissionId: ReviewSubmissionId; readonly state: string },
    item: { readonly id: string; readonly state: string | undefined },
  ) {
    const submitted = submission.state === "WAITING_FOR_REVIEW" || submission.state === "IN_REVIEW"
    if (submitted) {
      return submission
    }
    if (item.state === "REJECTED") {
      yield* api.send("PATCH", `/v1/reviewSubmissionItems/${enc(item.id)}`, {
        data: { type: "reviewSubmissionItems", id: item.id, attributes: { resolved: true } },
      })
    }
    return yield* submit(submission.submissionId)
  })

  // The app's draft submission for the platform, or a new one.
  const draftOf = Effect.fn("AppStoreConnect.draftOf")(function* (
    appId: AppId,
    platform: Platform,
    draft: Option.Option<{ readonly id: ReviewSubmissionId }>,
  ) {
    if (Option.isSome(draft)) {
      return draft.value.id
    }
    const text = yield* api.send("POST", "/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform },
        relationships: { app: { data: { type: "apps", id: appId } } },
      },
    })
    const created = yield* decoded(ReviewSubmissionDocument, text, "the review submission made")
    return created.data.id
  })

  const submit = Effect.fn("AppStoreConnect.submit")(function* (submissionId: ReviewSubmissionId) {
    const text = yield* api.send("PATCH", `/v1/reviewSubmissions/${enc(submissionId)}`, {
      data: { type: "reviewSubmissions", id: submissionId, attributes: { submitted: true } },
    })
    const submitted = yield* decoded(ReviewSubmissionDocument, text, "the review submission submitted")
    return reviewSubmissionOf(submitted)
  })

  const releaseVersion = Effect.fn("AppStoreConnect.releaseVersion")(function* (versionId: AppStoreVersionId) {
    const text = yield* api.get(`/v1/appStoreVersions/${enc(versionId)}`, {})
    const document = yield* decoded(AppStoreVersionDocument, text, "the App Store version")
    const current = yield* preparedVersionOf(document)
    // Apple can't take a release back, and refuses a second: one already made is done.
    if (releasedStates.has(current.state)) {
      return
    }
    yield* api.send("POST", "/v1/appStoreVersionReleaseRequests", {
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
      },
    })
  })

  const setPhasedRelease = Effect.fn("AppStoreConnect.setPhasedRelease")(function* (
    versionId: AppStoreVersionId,
    state: "pause" | "resume" | "complete",
  ) {
    const text = yield* api.get(`/v1/appStoreVersions/${enc(versionId)}`, { include: "appStoreVersionPhasedRelease" })
    const document = yield* decoded(AppStoreVersionDocument, text, "the App Store version")
    const phased = yield* versionPhasedReleaseOf(document)
    if (Option.isNone(phased)) {
      return yield* new AppStoreConnectRefused({
        status: 409,
        reason: `App Store version ${versionId} has no phased release`,
      })
    }
    const target = phasedReleaseState[state]
    if (phased.value.state === target) {
      return
    }
    yield* api.send("PATCH", `/v1/appStoreVersionPhasedReleases/${enc(phased.value.id)}`, {
      data: { type: "appStoreVersionPhasedReleases", id: phased.value.id, attributes: { phasedReleaseState: target } },
    })
  })

  const setWhatToTest = Effect.fn("AppStoreConnect.setWhatToTest")(function* (
    buildId: BuildId,
    notes: ReadonlyArray<LocalizedText>,
  ) {
    yield* checkLocales(notes, "What to Test")
    if (notes.length === 0) {
      return
    }
    const text = yield* api.get(`/v1/builds/${enc(buildId)}/betaBuildLocalizations`, { limit: pageSize })
    const document = yield* decoded(BetaBuildLocalizationsDocument, text, "beta build localizations")
    const localized: Localized = {
      type: "betaBuildLocalizations",
      owner: { relationship: "build", type: "builds", id: buildId },
    }
    const existing = localizationsOf(document)
    yield* Effect.forEach(notes, (note) => writeLocalized(localized, existing, note), { discard: true })
  })

  return { prepareVersion, submitForReview, releaseVersion, setPhasedRelease, setWhatToTest }
}

// Two texts for one locale are the caller's bug: which one Apple kept would depend on their order.
const checkLocales = (notes: ReadonlyArray<LocalizedText>, what: string) => {
  const locales = notes.map((note) => note.locale)
  const repeated = locales.find((locale, index) => locales.indexOf(locale) !== index)
  return repeated === undefined ? Effect.void : Effect.die(`${what} names the locale ${repeated} twice`)
}
