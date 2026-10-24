import { assert, describe, it } from "@effect/vitest"
import { Cause, DateTime, Effect, Exit, Layer, Option, Predicate, Result, Schema } from "effect"
import type { HttpClientRequest } from "effect/http"
import { HttpClient, HttpClientResponse } from "effect/http"

import type { AppStoreConnectRefused, AppStoreConnectUnavailable, VersionToSubmit } from "../src/index.ts"
import { AppId, AppStoreConnect, AppStoreVersionId, BuildId } from "../src/index.ts"
import { credentials, newKey, subtle } from "./signing-key.ts"

// The runtime's `Response` and `TextDecoder`, which tests outside a runtime with their types can't
// name: the parts these tests use.
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }
declare const Response: new (
  body: string | null,
  init: { readonly status: number; readonly headers?: Readonly<Record<string, string>> },
) => object

const api = "https://api.appstoreconnect.apple.com"

/** What the fake was asked: the method, the path, the query, the JSON body, decoded, and the media type asked for. */
interface Asked {
  readonly method: string
  readonly path: string
  readonly query: string
  readonly body: unknown
  readonly accept: string
}

/** An answer of the fake's: a status, and a document to send as JSON; none for a 204. */
interface Answer {
  readonly status: number
  readonly document?: unknown
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

// The JSON a request carries, decoded; undefined for one without a body.
const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? decodeJson(request.body.text ?? new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
    : Effect.void

// Apple's ErrorResponse, as its documentation describes it.
const appleError = (status: number, code: string, title: string, detail: string) => ({
  status,
  document: { errors: [{ id: "6b4c2f1e-9d3a-4c1b-8e2f-0a9b8c7d6e5f", status: String(status), code, title, detail }] },
})

const notFound = appleError(404, "NOT_FOUND", "The specified resource does not exist", "Nothing at this path")

const ok = (document: object): Answer => ({ status: 200, document })
const created = (document: object): Answer => ({ status: 201, document })
const noContent: Answer = { status: 204 }

/**
 * A fake App Store Connect: answers `"<METHOD> <path>"` with the answers listed for it, one after
 * another and the last again, and anything else 404; and keeps what it was asked, in order.
 */
const fakeAppStoreConnect = (answers: Readonly<Record<string, ReadonlyArray<Answer>>>) => {
  const asked: Array<Asked> = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = yield* bodyOf(request)
      const question = `${request.method} ${url.pathname}`
      const before = asked.filter((earlier) => `${earlier.method} ${earlier.path}` === question).length
      asked.push({
        method: request.method,
        path: url.pathname,
        query: decodeURIComponent(url.search),
        body,
        accept: request.headers["accept"] ?? "",
      })
      const listed = answers[question] ?? [notFound]
      const answer = listed[Math.min(before, listed.length - 1)] ?? notFound
      const text = answer.document === undefined ? null : yield* encodeJson(answer.document).pipe(Effect.orDie)
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: answer.status, headers: { "content-type": "application/json" } }),
      )
    }),
  )
  return { asked, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

type Fake = ReturnType<typeof fakeAppStoreConnect>

// Runs `program` with a client `make` builds through `fake`.
const withClient = <A, E>(fake: Fake, program: (client: AppStoreConnect["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const key = yield* newKey
    const client = yield* AppStoreConnect.make(credentials(key.pem), subtle).pipe(Effect.provide(fake.layer))
    return yield* program(client)
  })

// What the fake was asked, as `"<METHOD> <path>"`.
const questions = (fake: Fake) => fake.asked.map((asked) => `${asked.method} ${asked.path}`)

// The writes the fake was asked for, with their bodies.
const writes = (fake: Fake) =>
  fake.asked
    .filter((asked) => asked.method !== "GET")
    .map((asked) => ({ method: asked.method, path: asked.path, body: asked.body }))

// A failure's fields, to compare with what Apple's answer should make of it.
const plain = (failure: AppStoreConnectRefused | AppStoreConnectUnavailable) =>
  failure._tag === "AppStoreConnectRefused"
    ? { _tag: failure._tag, status: failure.status, reason: failure.reason }
    : { _tag: failure._tag, reason: failure.reason }

// What an effect's defect says, when it is text, as this client's are.
const defectOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return "succeeded"
  }
  const defect = Result.getOrUndefined(Cause.findDefect(exit.cause))
  return typeof defect === "string" ? defect : "a defect that isn't text"
}

// Apple's documents, as its documentation describes them (AppStoreVersionsResponse,
// AppStoreVersionResponse, AppStoreVersionLocalizationsResponse, ReviewSubmissionsResponse,
// ReviewSubmissionItemsResponse, BetaBuildLocalizationsResponse, AppInfosResponse), with fields
// Apple sends that this client ignores.

const appId = AppId.make("1574205213")
const build413 = BuildId.make("2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90")
const build412 = "d4c3b2a1-0f9e-4d8c-b7a6-958473625140"
const released = AppStoreVersionId.make("a1000000-0000-4000-8000-000000000240")
const editable = AppStoreVersionId.make("a1000000-0000-4000-8000-000000000250")
const made = "f5b10fc0-afda-4b31-b3e8-cdbcbe945622"
const phasedOfReleased = "c1000000-0000-4000-8000-000000000240"
const phasedOfEditable = "c1000000-0000-4000-8000-000000000250"

const version = (
  id: string,
  versionString: string,
  state: string,
  createdDate: string,
  related: { readonly build: string | null; readonly phasedRelease: string | null },
  releaseType = "AFTER_APPROVAL",
) => ({
  type: "appStoreVersions",
  id,
  attributes: {
    platform: "IOS",
    versionString,
    appVersionState: state,
    appStoreState: state,
    copyright: "2026 Example",
    reviewType: "APP_STORE",
    releaseType,
    earliestReleaseDate: null,
    downloadable: true,
    createdDate,
  },
  relationships: {
    build: { data: related.build === null ? null : { type: "builds", id: related.build } },
    appStoreVersionPhasedRelease: {
      data:
        related.phasedRelease === null ? null : { type: "appStoreVersionPhasedReleases", id: related.phasedRelease },
    },
    appStoreVersionLocalizations: {
      links: { related: `${api}/v1/appStoreVersions/${id}/appStoreVersionLocalizations` },
    },
  },
  links: { self: `${api}/v1/appStoreVersions/${id}` },
})

const shippedBuild = (id: string, buildNumber: string) => ({
  type: "builds",
  id,
  attributes: { version: buildNumber, uploadedDate: "2026-10-20T09:15:02-07:00", processingState: "VALID" },
})

const phasedRelease = (id: string, state: string) => ({
  type: "appStoreVersionPhasedReleases",
  id,
  attributes: { phasedReleaseState: state, startDate: null, totalPauseDuration: 0, currentDayNumber: null },
})

const releasedVersion = version(released, "2.4.0", "READY_FOR_DISTRIBUTION", "2026-10-15T11:02:33-07:00", {
  build: build412,
  phasedRelease: phasedOfReleased,
})

const versionsPage = (versions: Array<object>, included: Array<object>) => ({
  data: versions,
  included,
  links: { self: `${api}/v1/apps/${appId}/appStoreVersions` },
  meta: { paging: { total: versions.length, limit: 200 } },
})

// 2.4.0 is on the App Store; 2.5.0 is being prepared, with build 412 and a phased release.
const withEditable = (releaseType = "AFTER_APPROVAL") =>
  versionsPage(
    [
      releasedVersion,
      version(
        editable,
        "2.5.0",
        "PREPARE_FOR_SUBMISSION",
        "2026-10-21T08:30:00-07:00",
        { build: build412, phasedRelease: phasedOfEditable },
        releaseType,
      ),
    ],
    [
      shippedBuild(build412, "412"),
      phasedRelease(phasedOfReleased, "COMPLETE"),
      phasedRelease(phasedOfEditable, "INACTIVE"),
    ],
  )

// Apple's example answer to making a version: `appStoreState` alone, no `createdDate`, and
// relationships with links only.
const madeVersion = {
  data: {
    type: "appStoreVersions",
    id: made,
    attributes: {
      platform: "IOS",
      versionString: "2.5.0",
      appStoreState: "PREPARE_FOR_SUBMISSION",
      copyright: null,
      releaseType: "AFTER_APPROVAL",
      earliestReleaseDate: null,
      usesIdfa: false,
      downloadable: true,
    },
    relationships: {
      build: { links: { self: `${api}/v1/appStoreVersions/${made}/relationships/build` } },
      appStoreVersionPhasedRelease: {
        links: { self: `${api}/v1/appStoreVersions/${made}/relationships/appStoreVersionPhasedRelease` },
      },
    },
    links: { self: `${api}/v1/appStoreVersions/${made}` },
  },
  links: { self: `${api}/v1/appStoreVersions` },
}

const localizations = (type: string, entries: Array<{ id: string; locale: string; whatsNew: string | null }>) => ({
  data: entries.map((entry) => ({
    type,
    id: entry.id,
    attributes: { locale: entry.locale, whatsNew: entry.whatsNew },
    links: { self: `${api}/v1/${type}/${entry.id}` },
  })),
  links: { self: `${api}/v1/${type}` },
  meta: { paging: { total: entries.length, limit: 200 } },
})

const localization = (type: string, id: string, locale: string, whatsNew: string) => ({
  data: { type, id, attributes: { locale, whatsNew }, links: { self: `${api}/v1/${type}/${id}` } },
  links: { self: `${api}/v1/${type}/${id}` },
})

const enNotes = "Notes sync across your devices in seconds."
const deNotes = "Notizen werden in Sekunden auf allen Geräten abgeglichen."

const request = (changes: Partial<VersionToSubmit> = {}): VersionToSubmit => ({
  platform: "IOS",
  version: "2.5.0",
  buildId: build413,
  releaseType: "afterApproval",
  phased: true,
  whatsNew: [
    { locale: "en-US", text: enNotes },
    { locale: "de-DE", text: deNotes },
  ],
  ...changes,
})

const versionRelationship = (id: string) => ({ appStoreVersion: { data: { type: "appStoreVersions", id } } })

// 2.4.0 is on the App Store; 2.5.0, in `state`, already has build 413 and a phased release.
const readyIn = (state: string) =>
  versionsPage(
    [
      releasedVersion,
      version(editable, "2.5.0", state, "2026-10-21T08:30:00-07:00", {
        build: build413,
        phasedRelease: phasedOfEditable,
      }),
    ],
    [
      shippedBuild(build413, "413"),
      phasedRelease(phasedOfReleased, "COMPLETE"),
      phasedRelease(phasedOfEditable, "INACTIVE"),
    ],
  )

// The editable version's What's New, as `request()` asks.
const localizedAsAsked = localizations("appStoreVersionLocalizations", [
  { id: "l-en", locale: "en-US", whatsNew: enNotes },
  { id: "l-de", locale: "de-DE", whatsNew: deNotes },
])

describe("prepareVersion", () => {
  it.effect("makes a version when the app has none being prepared, and readies it", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [
          ok(
            versionsPage(
              [releasedVersion],
              [shippedBuild(build412, "412"), phasedRelease(phasedOfReleased, "COMPLETE")],
            ),
          ),
        ],
        "POST /v1/appStoreVersions": [created(madeVersion)],
        [`PATCH /v1/appStoreVersions/${made}/relationships/build`]: [noContent],
        "POST /v1/appStoreVersionPhasedReleases": [created({ data: phasedRelease("c2", "INACTIVE") })],
        // Apple copies the localizations of the version before into a new one.
        [`GET /v1/appStoreVersions/${made}/appStoreVersionLocalizations`]: [
          ok(
            localizations("appStoreVersionLocalizations", [
              { id: "l-en", locale: "en-US", whatsNew: "Faster search." },
              { id: "l-de", locale: "de-DE", whatsNew: "Schnellere Suche." },
            ]),
          ),
        ],
        "PATCH /v1/appStoreVersionLocalizations/l-en": [
          ok(localization("appStoreVersionLocalizations", "l-en", "en-US", enNotes)),
        ],
        "PATCH /v1/appStoreVersionLocalizations/l-de": [
          ok(localization("appStoreVersionLocalizations", "l-de", "de-DE", deNotes)),
        ],
      })
      const prepared = yield* withClient(fake, (client) => client.prepareVersion(appId, request()))

      assert.deepStrictEqual(prepared, { versionId: made, version: "2.5.0", state: "PREPARE_FOR_SUBMISSION" })
      assert.strictEqual(
        fake.asked[0]?.query,
        "?filter[platform]=IOS&include=build,appStoreVersionPhasedRelease&limit=200",
      )
      assert.isTrue(fake.asked.every((asked) => asked.accept === "application/json"))
      assert.deepStrictEqual(writes(fake), [
        {
          method: "POST",
          path: "/v1/appStoreVersions",
          body: {
            data: {
              type: "appStoreVersions",
              attributes: { platform: "IOS", versionString: "2.5.0", releaseType: "AFTER_APPROVAL" },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          },
        },
        {
          method: "PATCH",
          path: `/v1/appStoreVersions/${made}/relationships/build`,
          body: { data: { type: "builds", id: build413 } },
        },
        {
          method: "POST",
          path: "/v1/appStoreVersionPhasedReleases",
          body: {
            data: {
              type: "appStoreVersionPhasedReleases",
              attributes: { phasedReleaseState: "INACTIVE" },
              relationships: versionRelationship(made),
            },
          },
        },
        {
          method: "PATCH",
          path: "/v1/appStoreVersionLocalizations/l-en",
          body: { data: { type: "appStoreVersionLocalizations", id: "l-en", attributes: { whatsNew: enNotes } } },
        },
        {
          method: "PATCH",
          path: "/v1/appStoreVersionLocalizations/l-de",
          body: { data: { type: "appStoreVersionLocalizations", id: "l-de", attributes: { whatsNew: deNotes } } },
        },
      ])
    }),
  )

  it.effect(
    "changes the editable version's string and release type, swaps its build, cancels its phased release, and adds a missing locale",
    () =>
      Effect.gen(function* () {
        const fake = fakeAppStoreConnect({
          [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(withEditable())],
          [`PATCH /v1/appStoreVersions/${editable}`]: [
            ok({
              data: version(
                editable,
                "2.5.1",
                "PREPARE_FOR_SUBMISSION",
                "2026-10-21T08:30:00-07:00",
                { build: build412, phasedRelease: phasedOfEditable },
                "MANUAL",
              ),
            }),
          ],
          [`PATCH /v1/appStoreVersions/${editable}/relationships/build`]: [noContent],
          [`DELETE /v1/appStoreVersionPhasedReleases/${phasedOfEditable}`]: [noContent],
          [`GET /v1/appStoreVersions/${editable}/appStoreVersionLocalizations`]: [
            ok(localizations("appStoreVersionLocalizations", [{ id: "l-en", locale: "en-US", whatsNew: enNotes }])),
          ],
          "POST /v1/appStoreVersionLocalizations": [
            created(localization("appStoreVersionLocalizations", "l-de", "de-DE", deNotes)),
          ],
        })
        const prepared = yield* withClient(fake, (client) =>
          client.prepareVersion(appId, request({ version: "2.5.1", releaseType: "manual", phased: false })),
        )

        assert.deepStrictEqual(prepared, { versionId: editable, version: "2.5.1", state: "PREPARE_FOR_SUBMISSION" })
        assert.deepStrictEqual(writes(fake), [
          {
            method: "PATCH",
            path: `/v1/appStoreVersions/${editable}`,
            body: {
              data: {
                type: "appStoreVersions",
                id: editable,
                attributes: { versionString: "2.5.1", releaseType: "MANUAL" },
              },
            },
          },
          {
            method: "PATCH",
            path: `/v1/appStoreVersions/${editable}/relationships/build`,
            body: { data: { type: "builds", id: build413 } },
          },
          { method: "DELETE", path: `/v1/appStoreVersionPhasedReleases/${phasedOfEditable}`, body: undefined },
          // en-US already says this; de-DE is added.
          {
            method: "POST",
            path: "/v1/appStoreVersionLocalizations",
            body: {
              data: {
                type: "appStoreVersionLocalizations",
                attributes: { locale: "de-DE", whatsNew: deNotes },
                relationships: versionRelationship(editable),
              },
            },
          },
        ])
      }),
  )

  it.effect("repeats nothing when the version is already as asked", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(readyIn("PREPARE_FOR_SUBMISSION"))],
        [`GET /v1/appStoreVersions/${editable}/appStoreVersionLocalizations`]: [ok(localizedAsAsked)],
      })
      const prepared = yield* withClient(fake, (client) => client.prepareVersion(appId, request()))

      assert.deepStrictEqual(prepared, { versionId: editable, version: "2.5.0", state: "PREPARE_FOR_SUBMISSION" })
      assert.deepStrictEqual(questions(fake), [
        `GET /v1/apps/${appId}/appStoreVersions`,
        `GET /v1/appStoreVersions/${editable}/appStoreVersionLocalizations`,
      ])
      // Only the locale and What's New of each.
      assert.strictEqual(fake.asked[1]?.query, "?fields[appStoreVersionLocalizations]=locale,whatsNew&limit=200")
    }),
  )

  it.effect("prepares the editable version in each state Apple lets one be edited", () =>
    Effect.gen(function* () {
      for (const state of [
        "PREPARE_FOR_SUBMISSION",
        "READY_FOR_REVIEW",
        "INVALID_BINARY",
        "REJECTED",
        "METADATA_REJECTED",
        "DEVELOPER_REJECTED",
      ]) {
        const fake = fakeAppStoreConnect({
          [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(readyIn(state))],
          [`GET /v1/appStoreVersions/${editable}/appStoreVersionLocalizations`]: [ok(localizedAsAsked)],
        })
        const prepared = yield* withClient(fake, (client) => client.prepareVersion(appId, request()))
        assert.deepStrictEqual(prepared, { versionId: editable, version: "2.5.0", state }, state)
        assert.deepStrictEqual(writes(fake), [], state)
      }
    }),
  )

  it.effect("changes only what differs: the release type alone, and a build for a version without one", () =>
    Effect.gen(function* () {
      const withoutBuild = (releaseType: string) =>
        version(
          editable,
          "2.5.0",
          "PREPARE_FOR_SUBMISSION",
          "2026-10-21T08:30:00-07:00",
          { build: null, phasedRelease: phasedOfEditable },
          releaseType,
        )
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [
          ok(
            versionsPage(
              [releasedVersion, withoutBuild("AFTER_APPROVAL")],
              [
                shippedBuild(build412, "412"),
                phasedRelease(phasedOfReleased, "COMPLETE"),
                phasedRelease(phasedOfEditable, "INACTIVE"),
              ],
            ),
          ),
        ],
        [`PATCH /v1/appStoreVersions/${editable}`]: [ok({ data: withoutBuild("MANUAL") })],
        [`PATCH /v1/appStoreVersions/${editable}/relationships/build`]: [noContent],
        [`GET /v1/appStoreVersions/${editable}/appStoreVersionLocalizations`]: [ok(localizedAsAsked)],
      })
      yield* withClient(fake, (client) => client.prepareVersion(appId, request({ releaseType: "manual" })))

      assert.deepStrictEqual(writes(fake), [
        {
          method: "PATCH",
          path: `/v1/appStoreVersions/${editable}`,
          body: { data: { type: "appStoreVersions", id: editable, attributes: { releaseType: "MANUAL" } } },
        },
        {
          method: "PATCH",
          path: `/v1/appStoreVersions/${editable}/relationships/build`,
          body: { data: { type: "builds", id: build413 } },
        },
      ])
    }),
  )

  it.effect("reads no localizations when there is no text to write", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(readyIn("PREPARE_FOR_SUBMISSION"))],
      })
      yield* withClient(fake, (client) =>
        Effect.all([client.prepareVersion(appId, request({ whatsNew: [] })), client.setWhatToTest(build413, [])]),
      )
      assert.deepStrictEqual(questions(fake), [`GET /v1/apps/${appId}/appStoreVersions`])
    }),
  )

  it.effect("leaves What's New and the phased release out of an app's first version", () =>
    Effect.gen(function* () {
      const first = "a1000000-0000-4000-8000-000000000100"
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [
          ok(
            versionsPage(
              [
                version(first, "1.0", "REJECTED", "2026-10-01T10:00:00-07:00", {
                  build: build412,
                  phasedRelease: null,
                }),
              ],
              [shippedBuild(build412, "412")],
            ),
          ),
        ],
        [`PATCH /v1/appStoreVersions/${first}/relationships/build`]: [noContent],
      })
      const prepared = yield* withClient(fake, (client) =>
        client.prepareVersion(appId, request({ version: "1.0", phased: true })),
      )

      assert.deepStrictEqual(prepared, { versionId: first, version: "1.0", state: "REJECTED" })
      assert.deepStrictEqual(questions(fake), [
        `GET /v1/apps/${appId}/appStoreVersions`,
        `PATCH /v1/appStoreVersions/${first}/relationships/build`,
      ])
    }),
  )

  it.effect("is refused with Apple's detail when it won't take the build, and goes no further", () =>
    Effect.gen(function* () {
      // Apple's ErrorResponse for an entity it won't take (409); the detail's wording is this test's.
      const stillProcessing = appleError(
        409,
        "ENTITY_ERROR.RELATIONSHIP.INVALID",
        "The provided entity includes a relationship with an invalid value",
        "The build 413 is still processing and can't be added to a version yet.",
      )
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(withEditable())],
        [`PATCH /v1/appStoreVersions/${editable}/relationships/build`]: [stillProcessing],
      })
      const failure = yield* withClient(fake, (client) => client.prepareVersion(appId, request()).pipe(Effect.flip))

      assert.deepStrictEqual(plain(failure), {
        _tag: "AppStoreConnectRefused",
        status: 409,
        reason:
          "ENTITY_ERROR.RELATIONSHIP.INVALID: The build 413 is still processing and can't be added to a version yet.",
      })
      assert.deepStrictEqual(questions(fake), [
        `GET /v1/apps/${appId}/appStoreVersions`,
        `PATCH /v1/appStoreVersions/${editable}/relationships/build`,
      ])
    }),
  )

  it.effect("dies, sending nothing, on two What's New for one locale", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({})
      const twice = request({
        whatsNew: [
          { locale: "en-US", text: enNotes },
          { locale: "en-US", text: "Bug fixes." },
        ],
      })
      const defect = yield* withClient(fake, (client) =>
        client.prepareVersion(appId, twice).pipe(Effect.exit, Effect.map(defectOf)),
      )
      assert.strictEqual(defect, "What's New names the locale en-US twice")
      assert.strictEqual(fake.asked.length, 0)
    }),
  )
})

const submission = (id: string, state: string) => ({
  type: "reviewSubmissions",
  id,
  attributes: { platform: "IOS", submittedDate: null, state },
  relationships: { items: { links: { related: `${api}/v1/reviewSubmissions/${id}/items` } } },
  links: { self: `${api}/v1/reviewSubmissions/${id}` },
})

const submissions = (list: Array<object>) => ({
  data: list,
  links: { self: `${api}/v1/reviewSubmissions` },
  meta: { paging: { total: list.length, limit: 200 } },
})

const item = (id: string, state: string, versionId: string | null) => ({
  type: "reviewSubmissionItems",
  id,
  attributes: { state },
  relationships: {
    appStoreVersion: { data: versionId === null ? null : { type: "appStoreVersions", id: versionId } },
    appEvent: { links: { related: `${api}/v1/reviewSubmissionItems/${id}/appEvent` } },
  },
})

const items = (list: Array<object>) => ({ data: list, links: { self: `${api}/v1/reviewSubmissions/items` } })

const draft = "e1000000-0000-4000-8000-000000000001"

describe("submitForReview", () => {
  it.effect("makes a submission, adds the version to it, and submits it", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        "GET /v1/reviewSubmissions": [ok(submissions([]))],
        "POST /v1/reviewSubmissions": [created({ data: submission(draft, "READY_FOR_REVIEW") })],
        "POST /v1/reviewSubmissionItems": [created({ data: item("i1", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      const submitted = yield* withClient(fake, (client) => client.submitForReview(appId, "IOS", editable))

      assert.deepStrictEqual(submitted, { submissionId: draft, state: "WAITING_FOR_REVIEW" })
      assert.strictEqual(
        fake.asked[0]?.query,
        `?filter[app]=${appId}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW,UNRESOLVED_ISSUES&limit=200`,
      )
      assert.deepStrictEqual(writes(fake), [
        {
          method: "POST",
          path: "/v1/reviewSubmissions",
          body: {
            data: {
              type: "reviewSubmissions",
              attributes: { platform: "IOS" },
              relationships: { app: { data: { type: "apps", id: appId } } },
            },
          },
        },
        {
          method: "POST",
          path: "/v1/reviewSubmissionItems",
          body: {
            data: {
              type: "reviewSubmissionItems",
              relationships: {
                reviewSubmission: { data: { type: "reviewSubmissions", id: draft } },
                ...versionRelationship(editable),
              },
            },
          },
        },
        {
          method: "PATCH",
          path: `/v1/reviewSubmissions/${draft}`,
          body: { data: { type: "reviewSubmissions", id: draft, attributes: { submitted: true } } },
        },
      ])
    }),
  )

  it.effect("adds the version to the app's open draft, with what it already holds", () =>
    Effect.gen(function* () {
      const waiting = "e1000000-0000-4000-8000-000000000003"
      const fake = fakeAppStoreConnect({
        // A submission waiting for review, then the draft.
        "GET /v1/reviewSubmissions": [
          ok(submissions([submission(waiting, "WAITING_FOR_REVIEW"), submission(draft, "READY_FOR_REVIEW")])),
        ],
        [`GET /v1/reviewSubmissions/${waiting}/items`]: [ok(items([item("i9", "WAITING_FOR_REVIEW", null)]))],
        // The draft holds in-app events, no version: one named as Apple's example does, one with
        // its event alone, one with no relationships.
        [`GET /v1/reviewSubmissions/${draft}/items`]: [
          ok(
            items([
              item("i0", "READY_FOR_REVIEW", null),
              {
                type: "reviewSubmissionItems",
                id: "i2",
                attributes: { state: "READY_FOR_REVIEW" },
                relationships: { appEvent: { data: { type: "appEvents", id: "ev2" } } },
              },
              { type: "reviewSubmissionItems", id: "i3", attributes: { state: "READY_FOR_REVIEW" } },
            ]),
          ),
        ],
        "POST /v1/reviewSubmissionItems": [created({ data: item("i1", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      const submitted = yield* withClient(fake, (client) => client.submitForReview(appId, "IOS", editable))

      assert.deepStrictEqual(submitted, { submissionId: draft, state: "WAITING_FOR_REVIEW" })
      assert.deepStrictEqual(questions(fake), [
        "GET /v1/reviewSubmissions",
        `GET /v1/reviewSubmissions/${waiting}/items`,
        `GET /v1/reviewSubmissions/${draft}/items`,
        "POST /v1/reviewSubmissionItems",
        `PATCH /v1/reviewSubmissions/${draft}`,
      ])
      assert.strictEqual(fake.asked[1]?.query, "?include=appStoreVersion&limit=200")
    }),
  )

  it.effect("submits the draft that already holds the version, and leaves one submitted as it is", () =>
    Effect.gen(function* () {
      const inReview = "e1000000-0000-4000-8000-000000000002"
      const waiting = "e1000000-0000-4000-8000-000000000003"
      const fake = fakeAppStoreConnect({
        "GET /v1/reviewSubmissions": [
          ok(submissions([submission(draft, "READY_FOR_REVIEW")])),
          ok(submissions([submission(inReview, "IN_REVIEW")])),
          ok(submissions([submission(waiting, "WAITING_FOR_REVIEW")])),
        ],
        [`GET /v1/reviewSubmissions/${draft}/items`]: [ok(items([item("i1", "READY_FOR_REVIEW", editable)]))],
        [`GET /v1/reviewSubmissions/${inReview}/items`]: [ok(items([item("i2", "READY_FOR_REVIEW", editable)]))],
        [`GET /v1/reviewSubmissions/${waiting}/items`]: [ok(items([item("i3", "READY_FOR_REVIEW", editable)]))],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      const answers = yield* withClient(fake, (client) =>
        Effect.all(Array.from({ length: 3 }, () => client.submitForReview(appId, "IOS", editable))),
      )

      assert.deepStrictEqual(answers, [
        { submissionId: draft, state: "WAITING_FOR_REVIEW" },
        { submissionId: inReview, state: "IN_REVIEW" },
        { submissionId: waiting, state: "WAITING_FOR_REVIEW" },
      ])
      assert.deepStrictEqual(
        writes(fake).map((write) => `${write.method} ${write.path}`),
        [`PATCH /v1/reviewSubmissions/${draft}`],
      )
    }),
  )
})

describe("submitForReview, after App Review rejected the version", () => {
  it.effect("marks its item resolved and resubmits its submission", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        "GET /v1/reviewSubmissions": [ok(submissions([submission(draft, "UNRESOLVED_ISSUES")]))],
        [`GET /v1/reviewSubmissions/${draft}/items`]: [ok(items([item("i1", "REJECTED", editable)]))],
        "PATCH /v1/reviewSubmissionItems/i1": [ok({ data: item("i1", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      const submitted = yield* withClient(fake, (client) => client.submitForReview(appId, "IOS", editable))

      assert.deepStrictEqual(submitted, { submissionId: draft, state: "WAITING_FOR_REVIEW" })
      assert.deepStrictEqual(writes(fake), [
        {
          method: "PATCH",
          path: "/v1/reviewSubmissionItems/i1",
          body: { data: { type: "reviewSubmissionItems", id: "i1", attributes: { resolved: true } } },
        },
        {
          method: "PATCH",
          path: `/v1/reviewSubmissions/${draft}`,
          body: { data: { type: "reviewSubmissions", id: draft, attributes: { submitted: true } } },
        },
      ])
    }),
  )
})

describe("submitForReview, after the version was removed from its rejected submission", () => {
  it.effect("adds it to a new submission, since Apple doesn't take a removed item back", () =>
    Effect.gen(function* () {
      const rejected = "e1000000-0000-4000-8000-000000000004"
      const fake = fakeAppStoreConnect({
        "GET /v1/reviewSubmissions": [ok(submissions([submission(rejected, "UNRESOLVED_ISSUES")]))],
        [`GET /v1/reviewSubmissions/${rejected}/items`]: [ok(items([item("i1", "REMOVED", editable)]))],
        "POST /v1/reviewSubmissions": [created({ data: submission(draft, "READY_FOR_REVIEW") })],
        "POST /v1/reviewSubmissionItems": [created({ data: item("i2", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      const submitted = yield* withClient(fake, (client) => client.submitForReview(appId, "IOS", editable))

      assert.deepStrictEqual(submitted, { submissionId: draft, state: "WAITING_FOR_REVIEW" })
      assert.deepStrictEqual(
        writes(fake).map((write) => `${write.method} ${write.path}`),
        ["POST /v1/reviewSubmissions", "POST /v1/reviewSubmissionItems", `PATCH /v1/reviewSubmissions/${draft}`],
      )
    }),
  )
})

describe("releaseVersion", () => {
  it.effect("releases a version pending developer release, and leaves one released or being released as it is", () =>
    Effect.gen(function* () {
      const inState = (state: string) =>
        version(released, "2.4.0", state, "2026-10-15T11:02:33-07:00", { build: build412, phasedRelease: null })
      // An older answer, with `appStoreState` alone.
      const inOlderState = (state: string) => {
        const old = inState(state)
        return { ...old, attributes: { ...old.attributes, appVersionState: undefined } }
      }
      const releasedOrReleasing = [
        inState("PROCESSING_FOR_DISTRIBUTION"),
        inState("READY_FOR_DISTRIBUTION"),
        inState("REPLACED_WITH_NEW_VERSION"),
        inOlderState("PROCESSING_FOR_APP_STORE"),
        inOlderState("READY_FOR_SALE"),
      ]
      const fake = fakeAppStoreConnect({
        [`GET /v1/appStoreVersions/${released}`]: [
          ok({ data: inState("PENDING_DEVELOPER_RELEASE") }),
          ...releasedOrReleasing.map((data) => ok({ data })),
        ],
        "POST /v1/appStoreVersionReleaseRequests": [
          created({ data: { type: "appStoreVersionReleaseRequests", id: "r1" }, links: { self: `${api}/v1/r1` } }),
        ],
      })
      yield* withClient(fake, (client) => Effect.all(Array.from({ length: 6 }, () => client.releaseVersion(released))))

      assert.deepStrictEqual(writes(fake), [
        {
          method: "POST",
          path: "/v1/appStoreVersionReleaseRequests",
          body: { data: { type: "appStoreVersionReleaseRequests", relationships: versionRelationship(released) } },
        },
      ])
      assert.strictEqual(fake.asked.length, 7)
    }),
  )

  it.effect("is refused with Apple's detail for a version not pending release", () =>
    Effect.gen(function* () {
      const inReview = version(editable, "2.5.0", "IN_REVIEW", "2026-10-21T08:30:00-07:00", {
        build: build413,
        phasedRelease: null,
      })
      const fake = fakeAppStoreConnect({
        [`GET /v1/appStoreVersions/${editable}`]: [ok({ data: inReview })],
        "POST /v1/appStoreVersionReleaseRequests": [
          appleError(
            409,
            "STATE_ERROR",
            "The request cannot be fulfilled because of the state of another resource.",
            "The App Store version is not pending developer release.",
          ),
        ],
      })
      const failure = yield* withClient(fake, (client) => client.releaseVersion(editable).pipe(Effect.flip))
      assert.deepStrictEqual(plain(failure), {
        _tag: "AppStoreConnectRefused",
        status: 409,
        reason: "STATE_ERROR: The App Store version is not pending developer release.",
      })
    }),
  )
})

describe("setPhasedRelease", () => {
  it.effect("pauses, resumes, and completes a phased release, sending nothing when it is already so", () =>
    Effect.gen(function* () {
      const withPhased = (state: string) =>
        ok({
          data: version(released, "2.4.0", "READY_FOR_DISTRIBUTION", "2026-10-15T11:02:33-07:00", {
            build: build412,
            phasedRelease: phasedOfReleased,
          }),
          included: [phasedRelease(phasedOfReleased, state)],
        })
      const fake = fakeAppStoreConnect({
        [`GET /v1/appStoreVersions/${released}`]: [
          withPhased("ACTIVE"),
          withPhased("PAUSED"),
          withPhased("ACTIVE"),
          withPhased("COMPLETE"),
        ],
        [`PATCH /v1/appStoreVersionPhasedReleases/${phasedOfReleased}`]: [
          ok({ data: phasedRelease(phasedOfReleased, "PAUSED") }),
          ok({ data: phasedRelease(phasedOfReleased, "ACTIVE") }),
          ok({ data: phasedRelease(phasedOfReleased, "COMPLETE") }),
        ],
      })
      yield* withClient(fake, (client) =>
        Effect.all([
          client.setPhasedRelease(released, "pause"),
          client.setPhasedRelease(released, "resume"),
          client.setPhasedRelease(released, "complete"),
          client.setPhasedRelease(released, "complete"),
        ]),
      )

      assert.strictEqual(fake.asked[0]?.query, "?include=appStoreVersionPhasedRelease")
      assert.deepStrictEqual(
        writes(fake).map((write) => write.body),
        ["PAUSED", "ACTIVE", "COMPLETE"].map((state) => ({
          data: {
            type: "appStoreVersionPhasedReleases",
            id: phasedOfReleased,
            attributes: { phasedReleaseState: state },
          },
        })),
      )
    }),
  )

  it.effect("is refused for a version without a phased release, however the answer leaves it out", () =>
    Effect.gen(function* () {
      const withoutPhased = version(released, "2.4.0", "READY_FOR_DISTRIBUTION", "2026-10-15T11:02:33-07:00", {
        build: build412,
        phasedRelease: null,
      })
      const fake = fakeAppStoreConnect({
        [`GET /v1/appStoreVersions/${released}`]: [
          ok({ data: withoutPhased }),
          // Relationships that don't name a phased release, and none at all.
          ok({ data: { ...withoutPhased, relationships: { build: withoutPhased.relationships.build } } }),
          ok({ data: { ...withoutPhased, relationships: undefined } }),
        ],
      })
      const failures = yield* withClient(fake, (client) =>
        Effect.all(Array.from({ length: 3 }, () => client.setPhasedRelease(released, "pause").pipe(Effect.flip))),
      )
      for (const failure of failures) {
        assert.deepStrictEqual(plain(failure), {
          _tag: "AppStoreConnectRefused",
          status: 409,
          reason: `App Store version ${released} has no phased release`,
        })
      }
      assert.strictEqual(writes(fake).length, 0)
    }),
  )
})

// One of Apple's errors for an attribute it won't take.
const errorOf = (code: string, detail: string) => ({
  id: "6b4c2f1e-9d3a-4c1b-8e2f-0a9b8c7d6e5f",
  status: "409",
  code,
  title: "The provided entity includes an attribute with an invalid value",
  detail,
  source: { pointer: "/data/attributes/whatsNew" },
})

describe("setWhatToTest", () => {
  it.effect("changes one locale's What to Test and makes another's", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/builds/${build413}/betaBuildLocalizations`]: [
          ok(localizations("betaBuildLocalizations", [{ id: "b-en", locale: "en-US", whatsNew: "Try search." }])),
        ],
        "PATCH /v1/betaBuildLocalizations/b-en": [ok(localization("betaBuildLocalizations", "b-en", "en-US", enNotes))],
        "POST /v1/betaBuildLocalizations": [created(localization("betaBuildLocalizations", "b-de", "de-DE", deNotes))],
      })
      yield* withClient(fake, (client) =>
        client.setWhatToTest(build413, [
          { locale: "en-US", text: enNotes },
          { locale: "de-DE", text: deNotes },
        ]),
      )

      assert.deepStrictEqual(writes(fake), [
        {
          method: "PATCH",
          path: "/v1/betaBuildLocalizations/b-en",
          body: { data: { type: "betaBuildLocalizations", id: "b-en", attributes: { whatsNew: enNotes } } },
        },
        {
          method: "POST",
          path: "/v1/betaBuildLocalizations",
          body: {
            data: {
              type: "betaBuildLocalizations",
              attributes: { locale: "de-DE", whatsNew: deNotes },
              relationships: { build: { data: { type: "builds", id: build413 } } },
            },
          },
        },
      ])
      assert.strictEqual(fake.asked[0]?.query, "?limit=200")
    }),
  )

  it.effect("is refused with each of Apple's errors for a text it won't take", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/builds/${build413}/betaBuildLocalizations`]: [
          ok(localizations("betaBuildLocalizations", [{ id: "b-en", locale: "en-US", whatsNew: "Try search." }])),
        ],
        "PATCH /v1/betaBuildLocalizations/b-en": [
          {
            status: 409,
            document: {
              errors: [
                errorOf("ENTITY_ERROR.ATTRIBUTE.INVALID.TOO_LONG", "What to Test is longer than 4000 characters."),
                errorOf("ENTITY_ERROR.ATTRIBUTE.INVALID", "What to Test holds characters it can't."),
              ],
            },
          },
        ],
      })
      const failure = yield* withClient(fake, (client) =>
        client.setWhatToTest(build413, [{ locale: "en-US", text: enNotes }]).pipe(Effect.flip),
      )
      assert.deepStrictEqual(plain(failure), {
        _tag: "AppStoreConnectRefused",
        status: 409,
        reason:
          "ENTITY_ERROR.ATTRIBUTE.INVALID.TOO_LONG: What to Test is longer than 4000 characters.; ENTITY_ERROR.ATTRIBUTE.INVALID: What to Test holds characters it can't.",
      })
    }),
  )
})

// App information in `state`: as `state` and the deprecated `appStoreState`, or, for one of
// `appStoreState`'s names, as `appStoreState` alone, as older answers have it.
const info = (id: string, state: string | { readonly appStoreState: string }, localized: Array<string>) => ({
  type: "appInfos",
  id,
  attributes: {
    ...(typeof state === "string" ? { appStoreState: state, state } : state),
    appStoreAgeRating: "FOUR_PLUS",
  },
  relationships: {
    appInfoLocalizations: { data: localized.map((each) => ({ type: "appInfoLocalizations", id: each })) },
  },
})

const infoLocalization = (id: string, locale: string) => ({
  type: "appInfoLocalizations",
  id,
  attributes: { locale, name: "Notes", subtitle: null, privacyPolicyUrl: null },
})

describe("appLocales", () => {
  it.effect("lists the locales of the next version's app information, the primary first", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        [`GET /v1/apps/${appId}/appInfos`]: [
          ok({
            data: [
              info("live", "READY_FOR_DISTRIBUTION", ["live-en"]),
              info("next", "PREPARE_FOR_SUBMISSION", ["next-fr", "next-en", "next-de"]),
            ],
            included: [
              {
                type: "apps",
                id: appId,
                attributes: { name: "Notes", bundleId: "com.example.notes", primaryLocale: "en-US" },
              },
              infoLocalization("live-en", "en-US"),
              infoLocalization("next-fr", "fr-FR"),
              infoLocalization("next-en", "en-US"),
              infoLocalization("next-de", "de-DE"),
            ],
            links: { self: `${api}/v1/apps/${appId}/appInfos` },
          }),
        ],
      })
      const locales = yield* withClient(fake, (client) => client.appLocales(appId))

      assert.deepStrictEqual(locales, ["en-US", "de-DE", "fr-FR"])
      assert.strictEqual(fake.asked[0]?.query, "?include=app,appInfoLocalizations&limit[appInfoLocalizations]=50")
    }),
  )

  it.effect("lists the next version's locales whatever state the live information is in, else the live ones", () =>
    Effect.gen(function* () {
      const next = info("next", "PREPARE_FOR_SUBMISSION", ["next-de", "next-en"])
      const live = (state: string | { readonly appStoreState: string }) => info("live", state, ["live-en"])
      const cases: ReadonlyArray<readonly [Array<object>, Array<string>]> = [
        [
          [live("READY_FOR_DISTRIBUTION"), next],
          ["en-US", "de-DE"],
        ],
        [
          [live("REPLACED_WITH_NEW_INFO"), next],
          ["en-US", "de-DE"],
        ],
        [
          [live({ appStoreState: "READY_FOR_SALE" }), next],
          ["en-US", "de-DE"],
        ],
        [
          [live({ appStoreState: "REPLACED_WITH_NEW_VERSION" }), next],
          ["en-US", "de-DE"],
        ],
        [
          [live({ appStoreState: "DEVELOPER_REMOVED_FROM_SALE" }), next],
          ["en-US", "de-DE"],
        ],
        [
          [live({ appStoreState: "REMOVED_FROM_SALE" }), next],
          ["en-US", "de-DE"],
        ],
        // No version being prepared: the live information's.
        [[live("READY_FOR_DISTRIBUTION")], ["en-US"]],
        // Not in the primary locale: only the locales it is in.
        [[info("next", "PREPARE_FOR_SUBMISSION", ["next-fr", "next-de"])], ["de-DE", "fr-FR"]],
      ]
      for (const [data, expected] of cases) {
        const fake = fakeAppStoreConnect({
          [`GET /v1/apps/${appId}/appInfos`]: [
            ok({
              data,
              included: [
                { type: "apps", id: appId, attributes: { primaryLocale: "en-US" } },
                infoLocalization("live-en", "en-US"),
                infoLocalization("next-en", "en-US"),
                infoLocalization("next-de", "de-DE"),
                infoLocalization("next-fr", "fr-FR"),
              ],
              links: { self: `${api}/v1/apps/${appId}/appInfos` },
            }),
          ],
        })
        const locales = yield* withClient(fake, (client) => client.appLocales(appId))
        assert.deepStrictEqual(locales, expected)
      }
    }),
  )
})

const buildOf = (id: string, buildNumber: string, processingState: string) => ({
  type: "builds",
  id,
  attributes: {
    version: buildNumber,
    uploadedDate: "2026-10-22T09:15:02-07:00",
    expired: false,
    processingState,
    minOsVersion: "18.0",
  },
  relationships: {
    preReleaseVersion: { data: { type: "preReleaseVersions", id: "p250" } },
    buildBetaDetail: { data: null },
  },
})

const buildsOf250 = (data: Array<object>) => ({
  data,
  included: [{ type: "preReleaseVersions", id: "p250", attributes: { version: "2.5.0", platform: "IOS" } }],
  links: { self: `${api}/v1/builds` },
})

describe("build", () => {
  it.effect("finds the iOS build with exactly this version and number, and none before it is uploaded", () =>
    Effect.gen(function* () {
      // Apple's filters aren't documented as exact: 4130 of 2.5.0, and 413 of 2.5.1, come first.
      const of251 = {
        ...buildOf("b413-251", "413", "VALID"),
        relationships: {
          preReleaseVersion: { data: { type: "preReleaseVersions", id: "p251" } },
          buildBetaDetail: { data: null },
        },
      }
      const listed = buildsOf250([buildOf("b4130", "4130", "VALID"), of251, buildOf(build413, "413", "PROCESSING")])
      const fake = fakeAppStoreConnect({
        "GET /v1/builds": [
          ok({
            ...listed,
            included: [
              ...listed.included,
              { type: "preReleaseVersions", id: "p251", attributes: { version: "2.5.1", platform: "IOS" } },
            ],
          }),
          ok({ data: [], links: { self: `${api}/v1/builds` } }),
        ],
      })
      const found = yield* withClient(fake, (client) =>
        Effect.all([client.build(appId, "IOS", "2.5.0", "413"), client.build(appId, "IOS", "2.5.0", "414")]),
      )

      assert.deepStrictEqual(found, [
        Option.some({
          id: build413,
          platform: "IOS",
          version: "2.5.0",
          buildNumber: "413",
          uploadedAt: DateTime.makeUnsafe("2026-10-22T16:15:02Z"),
          processingState: "PROCESSING",
          expired: false,
        }),
        Option.none(),
      ])
      assert.strictEqual(
        fake.asked[0]?.query,
        `?filter[app]=${appId}&filter[preReleaseVersion.version]=2.5.0&filter[version]=413&filter[preReleaseVersion.platform]=IOS&include=preReleaseVersion,buildBetaDetail&limit=200`,
      )
    }),
  )
})

// A review submission's item, with these attributes, holding this App Store version.
const heldBy = (attributes: object, appStoreVersion: object) => ({
  type: "reviewSubmissionItems",
  id: "i1",
  attributes,
  relationships: { appStoreVersion },
})

describe("an answer without what a write needs", () => {
  it.effect("dies, saying what is off", () =>
    Effect.gen(function* () {
      const unread = "isn't in the shape this client reads"
      const withPhased = version(released, "2.4.0", "READY_FOR_DISTRIBUTION", "2026-10-15T11:02:33-07:00", {
        build: build412,
        phasedRelease: phasedOfReleased,
      })
      const toSubmit = {
        "POST /v1/reviewSubmissions": [created({ data: submission(draft, "READY_FOR_REVIEW") })],
        "POST /v1/reviewSubmissionItems": [created({ data: item("i1", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      }
      const cases: ReadonlyArray<{
        readonly answers: Readonly<Record<string, ReadonlyArray<Answer>>>
        readonly write: (
          client: AppStoreConnect["Service"],
        ) => Effect.Effect<unknown, AppStoreConnectRefused | AppStoreConnectUnavailable>
      }> = [
        // A version without its version string.
        {
          answers: {
            [`GET /v1/appStoreVersions/${released}`]: [
              ok({ data: { ...withPhased, attributes: { ...withPhased.attributes, versionString: undefined } } }),
            ],
          },
          write: (client) => client.releaseVersion(released),
        },
        // A version whose phased release is named without its ID.
        {
          answers: {
            [`GET /v1/appStoreVersions/${released}`]: [
              ok({
                data: {
                  ...withPhased,
                  relationships: { appStoreVersionPhasedRelease: { data: { type: "appStoreVersionPhasedReleases" } } },
                },
                included: [phasedRelease(phasedOfReleased, "ACTIVE")],
              }),
            ],
          },
          write: (client) => client.setPhasedRelease(released, "pause"),
        },
        // A localization without its locale.
        {
          answers: {
            [`GET /v1/builds/${build413}/betaBuildLocalizations`]: [
              ok({ data: [{ type: "betaBuildLocalizations", id: "b-en", attributes: { whatsNew: "Try search." } }] }),
            ],
          },
          write: (client) => client.setWhatToTest(build413, [{ locale: "en-US", text: enNotes }]),
        },
        // IDs that would leave their segment of the path they go into: a localization's, and a phased
        // release's.
        {
          answers: {
            [`GET /v1/builds/${build413}/betaBuildLocalizations`]: [
              ok(localizations("betaBuildLocalizations", [{ id: "..", locale: "en-US", whatsNew: "Try search." }])),
            ],
          },
          write: (client) => client.setWhatToTest(build413, [{ locale: "en-US", text: enNotes }]),
        },
        {
          answers: {
            [`GET /v1/appStoreVersions/${released}`]: [
              ok({
                data: {
                  ...withPhased,
                  relationships: {
                    ...withPhased.relationships,
                    appStoreVersionPhasedRelease: { data: { type: "appStoreVersionPhasedReleases", id: "../.." } },
                  },
                },
                included: [{ ...phasedRelease(phasedOfReleased, "ACTIVE"), id: "../.." }],
              }),
            ],
          },
          write: (client) => client.setPhasedRelease(released, "pause"),
        },
        // An open submission without its state.
        {
          answers: {
            "GET /v1/reviewSubmissions": [
              ok(submissions([{ ...submission(draft, "READY_FOR_REVIEW"), attributes: { platform: "IOS" } }])),
            ],
            [`GET /v1/reviewSubmissions/${draft}/items`]: [ok(items([]))],
            ...toSubmit,
          },
          write: (client) => client.submitForReview(appId, "IOS", editable),
        },
        // A submission submitted, answered without its state.
        {
          answers: {
            "GET /v1/reviewSubmissions": [ok(submissions([]))],
            ...toSubmit,
            [`PATCH /v1/reviewSubmissions/${draft}`]: [
              ok({ data: { ...submission(draft, "WAITING_FOR_REVIEW"), attributes: { platform: "IOS" } } }),
            ],
          },
          write: (client) => client.submitForReview(appId, "IOS", editable),
        },
        // An item whose version is named without its ID, and one whose state isn't text.
        {
          answers: {
            "GET /v1/reviewSubmissions": [ok(submissions([submission(draft, "READY_FOR_REVIEW")]))],
            [`GET /v1/reviewSubmissions/${draft}/items`]: [
              ok(items([heldBy({ state: "READY_FOR_REVIEW" }, { data: { type: "appStoreVersions" } })])),
            ],
            ...toSubmit,
          },
          write: (client) => client.submitForReview(appId, "IOS", editable),
        },
        {
          answers: {
            "GET /v1/reviewSubmissions": [ok(submissions([submission(draft, "READY_FOR_REVIEW")]))],
            [`GET /v1/reviewSubmissions/${draft}/items`]: [
              ok(items([heldBy({ state: 3 }, { data: { type: "appStoreVersions", id: editable } })])),
            ],
            ...toSubmit,
          },
          write: (client) => client.submitForReview(appId, "IOS", editable),
        },
      ]
      for (const { answers, write } of cases) {
        const fake = fakeAppStoreConnect(answers)
        const defect = yield* withClient(fake, (client) => write(client).pipe(Effect.exit, Effect.map(defectOf)))
        assert.include(defect, unread)
      }
    }),
  )
})

describe("platforms", () => {
  it.effect("asks for the platform given: a Mac app's build, a visionOS version, a tvOS submission", () =>
    Effect.gen(function* () {
      const fake = fakeAppStoreConnect({
        "GET /v1/builds": [ok({ data: [], links: { self: `${api}/v1/builds` } })],
        [`GET /v1/apps/${appId}/appStoreVersions`]: [ok(versionsPage([], []))],
        "POST /v1/appStoreVersions": [created(madeVersion)],
        [`PATCH /v1/appStoreVersions/${made}/relationships/build`]: [noContent],
        "GET /v1/reviewSubmissions": [ok(submissions([]))],
        "POST /v1/reviewSubmissions": [created({ data: submission(draft, "READY_FOR_REVIEW") })],
        "POST /v1/reviewSubmissionItems": [created({ data: item("i1", "READY_FOR_REVIEW", editable) })],
        [`PATCH /v1/reviewSubmissions/${draft}`]: [ok({ data: submission(draft, "WAITING_FOR_REVIEW") })],
      })
      yield* withClient(fake, (client) =>
        Effect.all([
          client.build(appId, "MAC_OS", "2.5.0", "413"),
          client.prepareVersion(appId, request({ platform: "VISION_OS" })),
          client.submitForReview(appId, "TV_OS", editable),
        ]),
      )
      const queries = fake.asked.filter((asked) => asked.method === "GET").map((asked) => asked.query)
      assert.include(queries[0], "filter[preReleaseVersion.platform]=MAC_OS")
      assert.include(queries[1], "filter[platform]=VISION_OS")
      assert.include(queries[2], "filter[platform]=TV_OS")
      const platforms = writes(fake).flatMap((write) => {
        const body = write.body
        const data = Predicate.hasProperty(body, "data") ? body.data : undefined
        const attributes = Predicate.hasProperty(data, "attributes") ? data.attributes : undefined
        return Predicate.hasProperty(attributes, "platform") ? [attributes.platform] : []
      })
      assert.deepStrictEqual(platforms, ["VISION_OS", "TV_OS"])
    }),
  )
})
