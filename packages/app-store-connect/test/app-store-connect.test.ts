import { assert, describe, it } from "@effect/vitest"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Result, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"

import type {
  AppStoreConnectCredentialsRefused,
  AppStoreConnectForbidden,
  AppStoreConnectRefused,
  AppStoreConnectUnavailable,
} from "../src/index.ts"
import { AppId, AppStoreConnect, AppStoreVersionId, BuildId, Platform } from "../src/index.ts"
import { credentials, newKey, subtle } from "./signing-key.ts"

// The runtime's `Response` and `TextDecoder`, which tests outside a runtime with their types can't
// name: the parts these tests use.
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }
declare const Response: new (
  body: string | null,
  init: { readonly status: number; readonly headers?: Readonly<Record<string, string>> },
) => object

const bytesOf = (base64Url: string | undefined) =>
  Result.getOrElse(Base64Url.decode(base64Url ?? ""), () => new Uint8Array(0))
const textOf = (base64Url: string | undefined) => new TextDecoder().decode(bytesOf(base64Url))

const api = "https://api.appstoreconnect.apple.com"

const now = DateTime.makeUnsafe("2026-10-22T10:00:00Z")
const nowSeconds = DateTime.toEpochMillis(now) / 1000

interface Asked {
  readonly url: string
  readonly authorization: string
  readonly accept: string
}

// What the fake answers: a JSON document, text, a connection that fails, or one that never answers.
type Answer =
  | { readonly status: number; readonly document: unknown }
  | { readonly status: number; readonly text: string }
  | "no answer"
  | "never"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// A fake App Store Connect: answers each request with the next of `answers`, and keeps what it was
// asked. `waiting` is done once it holds a request it will never answer.
const fakeAppStoreConnect = (answers: Array<Answer>) => {
  const asked: Array<Asked> = []
  const waiting = Deferred.makeUnsafe<void>()
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      asked.push({
        url: url.href,
        authorization: request.headers["authorization"] ?? "",
        accept: request.headers["accept"] ?? "",
      })
      const answer = answers.shift() ?? { status: 500, text: "" }
      if (answer === "never") {
        yield* Deferred.succeed(waiting, undefined)
        return yield* Effect.never
      }
      if (answer === "no answer") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "No route" }),
        })
      }
      const text = "text" in answer ? answer.text : yield* encodeJson(answer.document).pipe(Effect.orDie)
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, { status: answer.status, headers: { "content-type": "application/json" } }),
      )
    }),
  )
  return { asked, waiting, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

// Runs `program` with App Store Connect on `pem`, through `fake`.
const withAppStoreConnect = <A, E>(
  pem: string,
  fake: ReturnType<typeof fakeAppStoreConnect>,
  program: Effect.Effect<A, E, AppStoreConnect>,
) => program.pipe(Effect.provide(AppStoreConnect.layer(credentials(pem), subtle).pipe(Layer.provide(fake.layer))))

const findApp = (bundleId: string) =>
  Effect.gen(function* () {
    const appStoreConnect = yield* AppStoreConnect
    return yield* appStoreConnect.app(bundleId)
  })

const readBuilds = (limit: number) =>
  Effect.gen(function* () {
    const appStoreConnect = yield* AppStoreConnect
    return yield* appStoreConnect.builds(AppId.make("1574205213"), limit)
  })

const readVersions = (limit: number) =>
  Effect.gen(function* () {
    const appStoreConnect = yield* AppStoreConnect
    return yield* appStoreConnect.appStoreVersions(AppId.make("1574205213"), limit)
  })

const readLocales = Effect.gen(function* () {
  const appStoreConnect = yield* AppStoreConnect
  return yield* appStoreConnect.appLocales(AppId.make("1574205213"))
})

const ok = (document: object) => ({ status: 200, document })

// Apple's documents, as its documentation describes them (AppsResponse, BuildsResponse,
// AppStoreVersionsResponse, ErrorResponse), with the fields Apple sends that this client ignores.
const notes = {
  type: "apps",
  id: "1574205213",
  attributes: {
    name: "Notes",
    bundleId: "com.example.notes",
    sku: "NOTES2026",
    primaryLocale: "en-US",
    isOrEverWasMadeForKids: false,
    contentRightsDeclaration: null,
  },
  relationships: { builds: { links: { self: `${api}/v1/apps/1574205213/relationships/builds` } } },
  links: { self: `${api}/v1/apps/1574205213` },
}

const appsDocument = (apps: Array<object>) => ({
  data: apps,
  links: { self: `${api}/v1/apps?filter%5BbundleId%5D=com.example.notes&limit=200` },
  meta: { paging: { total: apps.length, limit: 200 } },
})

const buildsDocument = {
  data: [
    {
      type: "builds",
      id: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90",
      attributes: {
        version: "413",
        uploadedDate: "2026-10-20T09:15:02-07:00",
        expirationDate: "2027-01-18T09:15:02-08:00",
        expired: false,
        minOsVersion: "18.0",
        processingState: "VALID",
        buildAudienceType: "APP_STORE_ELIGIBLE",
        usesNonExemptEncryption: false,
        iconAssetToken: null,
      },
      relationships: {
        preReleaseVersion: {
          data: { type: "preReleaseVersions", id: "8f1d2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b" },
          links: { self: `${api}/v1/builds/2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90/relationships/preReleaseVersion` },
        },
        buildBetaDetail: {
          data: { type: "buildBetaDetails", id: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90" },
          links: { self: `${api}/v1/builds/2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90/relationships/buildBetaDetail` },
        },
      },
    },
    {
      type: "builds",
      id: "d4c3b2a1-0f9e-4d8c-b7a6-958473625140",
      attributes: {
        version: "412",
        uploadedDate: "2026-10-18T22:40:11-07:00",
        expirationDate: "2027-01-16T22:40:11-08:00",
        expired: true,
        minOsVersion: "18.0",
        processingState: "INVALID",
        buildAudienceType: "APP_STORE_ELIGIBLE",
        usesNonExemptEncryption: null,
      },
      relationships: {
        preReleaseVersion: { data: { type: "preReleaseVersions", id: "8f1d2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b" } },
        buildBetaDetail: { data: { type: "buildBetaDetails", id: "d4c3b2a1-0f9e-4d8c-b7a6-958473625140" } },
      },
    },
  ],
  included: [
    {
      type: "preReleaseVersions",
      id: "8f1d2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b",
      attributes: { version: "2.4.0", platform: "IOS" },
    },
    {
      type: "buildBetaDetails",
      id: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90",
      attributes: {
        autoNotifyEnabled: false,
        internalBuildState: "IN_BETA_TESTING",
        externalBuildState: "BETA_APPROVED",
      },
    },
    {
      type: "buildBetaDetails",
      id: "d4c3b2a1-0f9e-4d8c-b7a6-958473625140",
      attributes: { autoNotifyEnabled: false, internalBuildState: "EXPIRED", externalBuildState: null },
    },
  ],
  links: { self: `${api}/v1/builds?filter%5Bapp%5D=1574205213` },
  meta: { paging: { total: 2, limit: 2 } },
}

const version = (
  id: string,
  versionString: string,
  createdDate: string,
  state: { readonly appVersionState?: string; readonly appStoreState?: string },
  related: { readonly build: string | null; readonly phasedRelease: string | null },
  release: { readonly releaseType: string | null; readonly earliestReleaseDate: string | null } = {
    releaseType: "AFTER_APPROVAL",
    earliestReleaseDate: null,
  },
) => ({
  type: "appStoreVersions",
  id,
  attributes: {
    platform: "IOS",
    versionString,
    ...state,
    copyright: "2026 Example",
    ...release,
    downloadable: true,
    createdDate,
    reviewType: "APP_STORE",
  },
  relationships: {
    build: { data: related.build === null ? null : { type: "builds", id: related.build } },
    appStoreVersionPhasedRelease: {
      data:
        related.phasedRelease === null ? null : { type: "appStoreVersionPhasedReleases", id: related.phasedRelease },
    },
  },
  links: { self: `${api}/v1/appStoreVersions/${id}` },
})

const nextPage = `${api}/v1/apps/1574205213/appStoreVersions?cursor=Mg.ANl6Yxw&include=build%2CappStoreVersionPhasedRelease&limit=200`

// Two pages, in an order other than the latest first.
const versionPages = [
  {
    data: [
      version(
        "a1000000-0000-4000-8000-000000000240",
        "2.4.0",
        "2026-10-15T11:02:33-07:00",
        { appVersionState: "READY_FOR_DISTRIBUTION", appStoreState: "READY_FOR_SALE" },
        { build: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90", phasedRelease: "c1000000-0000-4000-8000-000000000240" },
      ),
      version(
        "a1000000-0000-4000-8000-000000000100",
        "1.0",
        "2025-03-02T08:00:00-08:00",
        { appStoreState: "REPLACED_WITH_NEW_VERSION" },
        { build: "e1000000-0000-4000-8000-000000000100", phasedRelease: null },
        { releaseType: null, earliestReleaseDate: null },
      ),
    ],
    included: [
      {
        type: "builds",
        id: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90",
        attributes: { version: "413", uploadedDate: "2026-10-20T09:15:02-07:00", processingState: "VALID" },
      },
      {
        type: "builds",
        id: "e1000000-0000-4000-8000-000000000100",
        attributes: { version: "7", uploadedDate: "2025-03-01T10:00:00-08:00", processingState: "VALID" },
      },
      {
        type: "appStoreVersionPhasedReleases",
        id: "c1000000-0000-4000-8000-000000000240",
        attributes: {
          phasedReleaseState: "ACTIVE",
          startDate: "2026-10-19T17:00:00Z",
          totalPauseDuration: 0,
          currentDayNumber: 3,
        },
      },
    ],
    links: { self: `${api}/v1/apps/1574205213/appStoreVersions`, next: nextPage },
    meta: { paging: { total: 3, limit: 200 } },
  },
  {
    data: [
      version(
        "a1000000-0000-4000-8000-000000000250",
        "2.5.0",
        "2026-10-21T08:30:00-07:00",
        { appVersionState: "PREPARE_FOR_SUBMISSION", appStoreState: "PREPARE_FOR_SUBMISSION" },
        { build: null, phasedRelease: "c1000000-0000-4000-8000-000000000250" },
        { releaseType: "SCHEDULED", earliestReleaseDate: "2026-11-02T17:00:00Z" },
      ),
    ],
    // A phased release not started yet: no start date, no day.
    included: [
      {
        type: "appStoreVersionPhasedReleases",
        id: "c1000000-0000-4000-8000-000000000250",
        attributes: { phasedReleaseState: "INACTIVE", startDate: null, totalPauseDuration: 0, currentDayNumber: null },
      },
    ],
    links: { self: nextPage },
    meta: { paging: { total: 3, limit: 200 } },
  },
]

const appleError = (status: number, code: string, detail: string) => ({
  status,
  document: { errors: [{ id: "6b4c2f1e-9d3a", status: String(status), code, title: code, detail }] },
})

const notAuthorized = appleError(
  401,
  "NOT_AUTHORIZED",
  "Provide a properly configured and signed bearer token, and make sure that it has not expired.",
)

// What an effect's defect says, when it is text, as this client's are.
const defectOf = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) {
    return "succeeded"
  }
  const defect = Result.getOrUndefined(Cause.findDefect(exit.cause))
  return typeof defect === "string" ? defect : "a defect that isn't text"
}

// A failure's fields, to compare with what Apple's answer should make of it.
type Failure =
  | AppStoreConnectCredentialsRefused
  | AppStoreConnectForbidden
  | AppStoreConnectRefused
  | AppStoreConnectUnavailable

const plain = (failure: Failure) => ({ _tag: failure._tag, reason: failure.reason })

// Version 2.5.0, being prepared, with these relationships.
const preparing = (
  relationships: object,
  state: { readonly appVersionState?: string } = { appVersionState: "PREPARE_FOR_SUBMISSION" },
) => ({
  ...version("a1000000-0000-4000-8000-000000000250", "2.5.0", "2026-10-21T08:30:00-07:00", state, {
    build: null,
    phasedRelease: null,
  }),
  relationships,
})

// The only page of an app's App Store versions.
const onePage = (data: Array<object>, included: Array<object> = []) => ({
  data,
  included,
  links: { self: `${api}/v1/apps/1574205213/appStoreVersions` },
})

// The app information for the version being prepared.
const appInfo = (attributes: object, relationships: object) => ({
  type: "appInfos",
  id: "info-next",
  attributes,
  relationships,
})

describe("AppStoreConnect", () => {
  it.effect("finds the app with a bundle ID, asking with a token its key signed", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([ok(appsDocument([notes]))])
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const app = yield* withAppStoreConnect(key.pem, fake, findApp("com.example.notes"))

      assert.deepStrictEqual(app, Option.some({ id: "1574205213", name: "Notes", bundleId: "com.example.notes" }))
      assert.strictEqual(fake.asked[0]?.url, `${api}/v1/apps?filter%5BbundleId%5D=com.example.notes&limit=200`)
      assert.strictEqual(fake.asked[0]?.accept, "application/json")

      // An ES256 JWT: its header names the key, its claims the issuer, Apple's audience, and a
      // 20-minute life from now, and its signature verifies.
      const [header, claims, signature] = (fake.asked[0]?.authorization ?? "").replace("Bearer ", "").split(".")
      assert.strictEqual(textOf(header), '{"alg":"ES256","kid":"2X9R4HXF34","typ":"JWT"}')
      assert.strictEqual(
        textOf(claims),
        `{"iss":"57246542-96fe-1a63-e053-0824d011072a","iat":${nowSeconds},"exp":${nowSeconds + 20 * 60},"aud":"appstoreconnect-v1"}`,
      )
      const verified = yield* Effect.promise(() =>
        subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key.publicKey,
          bytesOf(signature),
          Uint8Array.from(`${header}.${claims}`, (character) => character.charCodeAt(0)),
        ),
      )
      assert.isTrue(verified)
    }),
  )

  it.effect("finds none when the team has no app with exactly that bundle ID", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const widget = { ...notes, attributes: { ...notes.attributes, bundleId: "com.example.notes.widget" } }
      const fake = fakeAppStoreConnect([ok(appsDocument([])), ok(appsDocument([widget]))])
      const apps = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all([findApp("com.example.notes"), findApp("com.example.notes")]),
      )
      assert.deepStrictEqual(apps, [Option.none(), Option.none()])
    }),
  )

  it.effect("reads builds, the latest uploaded first, with their marketing versions and TestFlight states", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([ok(buildsDocument)])
      const builds = yield* withAppStoreConnect(key.pem, fake, readBuilds(2))

      assert.strictEqual(
        fake.asked[0]?.url,
        `${api}/v1/builds?filter%5Bapp%5D=1574205213&sort=-uploadedDate&include=preReleaseVersion%2CbuildBetaDetail&limit=2`,
      )
      assert.deepStrictEqual(builds, [
        {
          id: BuildId.make("2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90"),
          platform: "IOS",
          version: "2.4.0",
          buildNumber: "413",
          uploadedAt: DateTime.makeUnsafe("2026-10-20T16:15:02Z"),
          processingState: "VALID",
          expired: false,
          internalTesting: "IN_BETA_TESTING",
          externalTesting: "BETA_APPROVED",
        },
        {
          id: BuildId.make("d4c3b2a1-0f9e-4d8c-b7a6-958473625140"),
          platform: "IOS",
          version: "2.4.0",
          buildNumber: "412",
          uploadedAt: DateTime.makeUnsafe("2026-10-19T05:40:11Z"),
          processingState: "INVALID",
          expired: true,
          internalTesting: "EXPIRED",
        },
      ])
    }),
  )

  it.effect(
    "reads every page of App Store versions, the latest created first, with their builds and phased releases",
    () =>
      Effect.gen(function* () {
        const key = yield* newKey
        const fake = fakeAppStoreConnect([ok(versionPages[0] ?? {}), ok(versionPages[1] ?? {})])
        const versions = yield* withAppStoreConnect(key.pem, fake, readVersions(2))

        assert.deepStrictEqual(
          fake.asked.map((asked) => asked.url),
          [
            `${api}/v1/apps/1574205213/appStoreVersions?include=build%2CappStoreVersionPhasedRelease&limit=200`,
            nextPage,
          ],
        )
        assert.isTrue(fake.asked.every((asked) => asked.accept === "application/json"))
        assert.deepStrictEqual(versions, [
          {
            id: AppStoreVersionId.make("a1000000-0000-4000-8000-000000000250"),
            platform: "IOS",
            version: "2.5.0",
            state: "PREPARE_FOR_SUBMISSION",
            releaseType: "SCHEDULED",
            createdAt: DateTime.makeUnsafe("2026-10-21T15:30:00Z"),
            earliestReleaseAt: DateTime.makeUnsafe("2026-11-02T17:00:00Z"),
            phasedRelease: { state: "INACTIVE" },
          },
          {
            id: AppStoreVersionId.make("a1000000-0000-4000-8000-000000000240"),
            platform: "IOS",
            version: "2.4.0",
            state: "READY_FOR_DISTRIBUTION",
            releaseType: "AFTER_APPROVAL",
            createdAt: DateTime.makeUnsafe("2026-10-15T18:02:33Z"),
            buildNumber: "413",
            phasedRelease: { state: "ACTIVE", startedAt: DateTime.makeUnsafe("2026-10-19T17:00:00Z"), currentDay: 3 },
          },
        ])
      }),
  )

  it.effect("takes a version's App Store state when Apple gives no other, and leaves out what it doesn't give", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([ok(versionPages[0] ?? {}), ok(versionPages[1] ?? {})])
      const versions = yield* withAppStoreConnect(key.pem, fake, readVersions(200))
      assert.strictEqual(versions.length, 3)
      // No release type, no phased release.
      assert.deepStrictEqual(versions.at(-1), {
        id: AppStoreVersionId.make("a1000000-0000-4000-8000-000000000100"),
        platform: "IOS",
        version: "1.0",
        state: "REPLACED_WITH_NEW_VERSION",
        createdAt: DateTime.makeUnsafe("2025-03-02T16:00:00Z"),
        buildNumber: "7",
      })
    }),
  )

  it.effect("reads at most 10 pages of App Store versions, and dies past them", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const endless = Array.from({ length: 11 }, (_, page) =>
        ok({
          data: [],
          links: {
            self: `${api}/v1/apps/1574205213/appStoreVersions`,
            next: `${api}/v1/apps/1574205213/appStoreVersions?cursor=${page + 1}&limit=200`,
          },
        }),
      )
      const fake = fakeAppStoreConnect(endless)
      const defect = yield* withAppStoreConnect(key.pem, fake, readVersions(10).pipe(Effect.exit, Effect.map(defectOf)))
      // 2,000 versions, 200 a page: what it says is more than it reads.
      assert.include(defect, "2000")
      assert.strictEqual(fake.asked.length, 10)
    }),
  )

  it.effect("dies, asking nothing, on a limit outside 1 to 200, and takes 1", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([ok(buildsDocument)])
      const exits = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all(
          [0, 1.5, 201].flatMap((limit) => [
            readBuilds(limit).pipe(Effect.asVoid, Effect.exit),
            readVersions(limit).pipe(Effect.asVoid, Effect.exit),
          ]),
        ),
      )
      for (const exit of exits) {
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause))
      }
      assert.strictEqual(fake.asked.length, 0)
      yield* withAppStoreConnect(key.pem, fake, readBuilds(1))
      assert.include(fake.asked[0]?.url, "&limit=1")
    }),
  )

  it.effect("renews a token Apple refuses, once, and fails when Apple refuses the new one too", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([notAuthorized, ok(appsDocument([notes])), notAuthorized, notAuthorized])
      const answers = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all([findApp("com.example.notes"), findApp("com.example.notes").pipe(Effect.flip)]),
      )

      assert.isTrue(Option.isSome(answers[0]))
      assert.isFalse(answers[1].isRetryable)
      assert.deepStrictEqual(plain(answers[1]), {
        _tag: "AppStoreConnectCredentialsRefused",
        reason:
          "NOT_AUTHORIZED: Provide a properly configured and signed bearer token, and make sure that it has not expired.",
      })
      const tokens = fake.asked.map((asked) => asked.authorization)
      assert.strictEqual(tokens.length, 4)
      assert.notStrictEqual(tokens[0], tokens[1])
      assert.notStrictEqual(tokens[2], tokens[3])
    }),
  )

  it.effect("is forbidden a role or an agreement short, and unavailable when Apple is busy, down, or silent", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([
        appleError(403, "FORBIDDEN_ERROR", "The API key in use does not allow this request"),
        appleError(
          403,
          "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED",
          "This request requires an in-effect agreement that has not been signed or has expired.",
        ),
        appleError(429, "RATE_LIMIT_EXCEEDED", "We've received too many requests for this API."),
        { status: 503, text: "<html><body>Service Unavailable</body></html>" },
        "no answer",
        // An error not in Apple's shape, without its detail: the status says it.
        { status: 500, document: { errors: [{ status: "500", code: "UNEXPECTED_ERROR", title: "Unexpected" }] } },
      ])
      const failures = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all([
          readBuilds(10).pipe(Effect.flip),
          readBuilds(10).pipe(Effect.flip),
          readBuilds(10).pipe(Effect.flip),
          readBuilds(10).pipe(Effect.flip),
          readBuilds(10).pipe(Effect.flip),
          readBuilds(10).pipe(Effect.flip),
        ]),
      )
      assert.deepStrictEqual(plain(failures[0]), {
        _tag: "AppStoreConnectForbidden",
        reason: "FORBIDDEN_ERROR: The API key in use does not allow this request",
      })
      assert.deepStrictEqual(plain(failures[1]), {
        _tag: "AppStoreConnectForbidden",
        reason:
          "FORBIDDEN.REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED: This request requires an in-effect agreement that has not been signed or has expired.",
      })
      assert.deepStrictEqual(plain(failures[2]), {
        _tag: "AppStoreConnectUnavailable",
        reason: "RATE_LIMIT_EXCEEDED: We've received too many requests for this API.",
      })
      assert.deepStrictEqual(plain(failures[3]), { _tag: "AppStoreConnectUnavailable", reason: "HTTP 503" })
      assert.deepStrictEqual(plain(failures[4]), {
        _tag: "AppStoreConnectUnavailable",
        reason: "App Store Connect couldn't be reached",
      })
      assert.deepStrictEqual(plain(failures[5]), { _tag: "AppStoreConnectUnavailable", reason: "HTTP 500" })
      // What a log shows carries the reason, and only an outage is worth asking again.
      for (const failure of failures) {
        assert.include(failure.message, failure.reason)
        assert.strictEqual(failure.isRetryable, failure._tag === "AppStoreConnectUnavailable")
      }
    }),
  )

  it.effect("is unavailable when Apple doesn't answer in 15 seconds", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect(["never"])
      const failure = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(readBuilds(10).pipe(Effect.flip))
          yield* Deferred.await(fake.waiting)
          yield* TestClock.adjust("15 seconds")
          return yield* Fiber.join(fiber)
        }),
      )
      assert.deepStrictEqual(plain(failure), {
        _tag: "AppStoreConnectUnavailable",
        reason: "App Store Connect didn't answer in 15 seconds",
      })
    }),
  )

  it.effect("reuses its token for 15 minutes, then signs another", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([
        ok(appsDocument([notes])),
        ok(appsDocument([notes])),
        ok(appsDocument([notes])),
      ])
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.gen(function* () {
          yield* findApp("com.example.notes")
          yield* TestClock.adjust("14 minutes")
          yield* findApp("com.example.notes")
          yield* TestClock.adjust("1 minute")
          yield* findApp("com.example.notes")
        }),
      )
      const tokens = fake.asked.map((asked) => asked.authorization)
      assert.strictEqual(tokens[0], tokens[1])
      assert.notStrictEqual(tokens[1], tokens[2])
    }),
  )

  it.effect("fails to build, sending nothing, with credentials that can't sign Apple's tokens", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect([])
      const refused = [
        [credentials("-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----"), "key"],
        [{ ...credentials(key.pem), keyId: "2x9r4hxf34" }, "ID"],
        // The key's file name, and the ID as a file of settings ends it.
        [{ ...credentials(key.pem), keyId: "AuthKey_2X9R4HXF34" }, "ID"],
        [{ ...credentials(key.pem), keyId: "2X9R4HXF34\n" }, "ID"],
        [{ ...credentials(key.pem), issuerId: "not a UUID" }, "ID"],
        [{ ...credentials(key.pem), issuerId: " 57246542-96fe-1a63-e053-0824d011072a" }, "ID"],
        [{ ...credentials(key.pem), issuerId: "57246542-96fe-1a63-e053-0824d011072a\n" }, "ID"],
      ] as const
      for (const [settings, wrong] of refused) {
        const failure = yield* AppStoreConnect.make(settings, subtle).pipe(Effect.provide(fake.layer), Effect.flip)
        assert.strictEqual(failure._tag, "AppStoreConnectCredentialsInvalid")
        // Its reason says which is wrong, and its message carries the reason.
        assert.include(failure.reason, wrong)
        assert.include(failure.message, failure.reason)
      }
      assert.strictEqual(fake.asked.length, 0)
    }),
  )

  it("takes an ID only as one segment of a path: never . or .., nor anything a URL encodes", () => {
    for (const id of ["..", ".", "", "a/b", "a b", "%2e%2e"]) {
      assert.isFalse(Schema.is(BuildId)(id), id)
      assert.isFalse(Schema.is(AppStoreVersionId)(id), id)
    }
    assert.isTrue(Schema.is(BuildId)("2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90"))
    assert.isTrue(Schema.is(AppId)("1574205213"))
    for (const id of ["1574205213/..", "../1574205213", "id1574205213"]) {
      assert.isFalse(Schema.is(AppId)(id), id)
    }
  })

  it("names the platforms as Apple does", () => {
    for (const platform of ["IOS", "MAC_OS", "TV_OS", "VISION_OS"]) {
      assert.isTrue(Schema.is(Platform)(platform), platform)
    }
    for (const platform of ["ios", "IPHONE_OS", "WATCH_OS", ""]) {
      assert.isFalse(Schema.is(Platform)(platform), platform)
    }
  })

  it.effect("signs one token for requests sent together", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const fake = fakeAppStoreConnect(Array.from({ length: 6 }, () => ok(appsDocument([notes]))))
      yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all(
          Array.from({ length: 6 }, () => findApp("com.example.notes")),
          { concurrency: "unbounded" },
        ),
      )
      assert.strictEqual(new Set(fake.asked.map((asked) => asked.authorization)).size, 1)
    }),
  )

  it.effect("dies, saying what is off, on an answer it can't read", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const [first, second] = buildsDocument.data
      const withoutUpload = { ...first, attributes: { ...first?.attributes, uploadedDate: undefined } }
      const fake = fakeAppStoreConnect([
        ok({ ...buildsDocument, data: [withoutUpload] }),
        ok({ ...buildsDocument, data: [second], included: [] }),
        ok({ ...versionPages[1], links: { self: nextPage, next: "https://example.com/v1/apps/1/appStoreVersions" } }),
      ])
      const defects = yield* withAppStoreConnect(
        key.pem,
        fake,
        Effect.all([
          readBuilds(10).pipe(Effect.exit, Effect.map(defectOf)),
          readBuilds(10).pipe(Effect.exit, Effect.map(defectOf)),
          readVersions(10).pipe(Effect.exit, Effect.map(defectOf)),
        ]),
      )
      assert.match(defects[0] ?? "", /^App Store Connect's answer of builds isn't in the shape this client reads/)
      assert.match(defects[0] ?? "", /uploadedDate/)
      assert.match(
        defects[1] ?? "",
        /relates preReleaseVersions 8f1d2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b, which it doesn't include/,
      )
      assert.strictEqual(
        defects[2],
        "App Store Connect's next page is outside its API: https://example.com/v1/apps/1/appStoreVersions",
      )
      assert.strictEqual(fake.asked.length, 3)
    }),
  )

  it.effect("dies, saying what is off, on an answer without what it needs, or with a status it doesn't take", () =>
    Effect.gen(function* () {
      const key = yield* newKey
      const unread = "isn't in the shape this client reads"
      const [build] = buildsDocument.data
      const [preReleaseVersion, betaDetail, expiredBetaDetail] = buildsDocument.included
      const localized = { appInfoLocalizations: { data: [{ type: "appInfoLocalizations", id: "l-en" }] } }
      const notesApp = { type: "apps", id: "1574205213", attributes: { primaryLocale: "en-US" } }
      const english = { type: "appInfoLocalizations", id: "l-en", attributes: { locale: "en-US" } }
      const appInfos = (data: Array<object>, included: Array<object> = [notesApp, english]) => ({
        data,
        included,
        links: { self: `${api}/v1/apps/1574205213/appInfos` },
      })
      const preparingInfo = { state: "PREPARE_FOR_SUBMISSION" }
      const cases: ReadonlyArray<{
        readonly read: Effect.Effect<unknown, Failure, AppStoreConnect>
        readonly answers: Array<Answer>
        readonly says: ReadonlyArray<string>
      }> = [
        // An app without its name.
        {
          read: findApp("com.example.notes"),
          answers: [ok(appsDocument([{ ...notes, attributes: { ...notes.attributes, name: undefined } }]))],
          says: [unread],
        },
        // A build whose prerelease version is named without its ID.
        {
          read: readBuilds(10),
          answers: [
            ok({
              ...buildsDocument,
              data: [
                {
                  ...build,
                  relationships: {
                    ...build?.relationships,
                    preReleaseVersion: { data: { type: "preReleaseVersions" } },
                  },
                },
              ],
            }),
          ],
          says: [unread],
        },
        // A prerelease version without its platform.
        {
          read: readBuilds(10),
          answers: [
            ok({
              ...buildsDocument,
              included: [{ ...preReleaseVersion, attributes: { version: "2.4.0" } }, betaDetail, expiredBetaDetail],
            }),
          ],
          says: [unread],
        },
        // A beta detail whose state isn't text.
        {
          read: readBuilds(10),
          answers: [
            ok({
              ...buildsDocument,
              included: [
                preReleaseVersion,
                { ...betaDetail, attributes: { ...betaDetail?.attributes, internalBuildState: 3 } },
                expiredBetaDetail,
              ],
            }),
          ],
          says: [unread],
        },
        // A version whose build is named without its ID.
        {
          read: readVersions(10),
          answers: [
            ok(
              onePage([
                preparing({ build: { data: { type: "builds" } }, appStoreVersionPhasedRelease: { data: null } }),
              ]),
            ),
          ],
          says: [unread],
        },
        // A shipped build without its number.
        {
          read: readVersions(10),
          answers: [
            ok(
              onePage(
                [
                  version(
                    "a1000000-0000-4000-8000-000000000240",
                    "2.4.0",
                    "2026-10-15T11:02:33-07:00",
                    { appVersionState: "READY_FOR_DISTRIBUTION" },
                    { build: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90", phasedRelease: null },
                  ),
                ],
                [
                  {
                    type: "builds",
                    id: "2b9f3c4e-71aa-4d0e-9a3f-5c1e2d7b8a90",
                    attributes: { uploadedDate: "2026-10-20T09:15:02-07:00", processingState: "VALID" },
                  },
                ],
              ),
            ),
          ],
          says: [unread],
        },
        // A version without a state.
        {
          read: readVersions(10),
          answers: [
            ok(onePage([preparing({ build: { data: null }, appStoreVersionPhasedRelease: { data: null } }, {})])),
          ],
          says: ["a1000000-0000-4000-8000-000000000250 no state"],
        },
        // A page whose next link isn't text.
        {
          read: readVersions(10),
          answers: [ok({ ...versionPages[1], links: { self: nextPage, next: 2 } })],
          says: [unread],
        },
        // App information whose localizations aren't named.
        {
          read: readLocales,
          answers: [ok(appInfos([appInfo(preparingInfo, { appInfoLocalizations: {} })]))],
          says: [unread],
        },
        // App information whose state isn't text.
        {
          read: readLocales,
          answers: [ok(appInfos([appInfo({ state: 3 }, localized)]))],
          says: [unread],
        },
        // The app without its primary locale.
        {
          read: readLocales,
          answers: [ok(appInfos([appInfo(preparingInfo, localized)], [{ ...notesApp, attributes: {} }, english]))],
          says: [unread],
        },
        // A localization without its locale.
        {
          read: readLocales,
          answers: [ok(appInfos([appInfo(preparingInfo, localized)], [notesApp, { ...english, attributes: {} }]))],
          says: [unread],
        },
        // No app information at all.
        {
          read: readLocales,
          answers: [ok(appInfos([]))],
          says: ["app 1574205213 no app info"],
        },
        // A status Apple's API answers a request it can't take with, such as 404 for an app the team no longer has.
        {
          read: readBuilds(10),
          answers: [appleError(404, "NOT_FOUND", "The specified resource does not exist")],
          says: ["GET /v1/builds", "HTTP 404", "NOT_FOUND"],
        },
      ]
      for (const { read, answers, says } of cases) {
        const defect = yield* withAppStoreConnect(key.pem, fakeAppStoreConnect(answers), read).pipe(
          Effect.exit,
          Effect.map(defectOf),
        )
        for (const said of says) {
          assert.include(defect, said)
        }
      }
    }),
  )
})
