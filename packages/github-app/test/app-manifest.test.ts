import { assert, describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Redacted, Schema, Tracer } from "effect"

import { AppSlug, appManifest, convertManifest, installLink } from "../src/index.ts"
import { factsOf, fakeGitHub } from "./fake-github.ts"
import { errorJson, manifestConversionJson } from "./github-answers.ts"

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAtestkeynotreal\n-----END RSA PRIVATE KEY-----\n"

describe("appManifest", () => {
  it.effect("builds the form that creates an app, with its webhook, for an organization", () =>
    Effect.gen(function* () {
      const form = yield* appManifest({
        name: "Notes releases",
        url: "https://notes.example",
        redirectUrl: "https://notes.example/github/created",
        callbackUrl: "https://notes.example/github/authorized",
        setupUrl: "https://notes.example/github/installed",
        webhookUrl: "https://notes.example/github/webhooks",
        permissions: { actions: "write", contents: "read", metadata: "read" },
        events: ["workflow_run"],
        public: false,
        state: "c2b1 f/e+=",
        organization: "octo-org",
      })
      assert.strictEqual(
        form.action,
        "https://github.com/organizations/octo-org/settings/apps/new?state=c2b1%20f%2Fe%2B%3D",
      )
      const manifest = yield* decodeJson(form.manifest)
      assert.deepStrictEqual(manifest, {
        name: "Notes releases",
        url: "https://notes.example",
        hook_attributes: { url: "https://notes.example/github/webhooks" },
        redirect_url: "https://notes.example/github/created",
        callback_urls: ["https://notes.example/github/authorized"],
        setup_url: "https://notes.example/github/installed",
        public: false,
        default_permissions: { actions: "write", contents: "read", metadata: "read" },
        default_events: ["workflow_run"],
      })
    }),
  )

  it.effect("leaves the webhook out of an app without a webhook URL, for a personal account", () =>
    Effect.gen(function* () {
      const form = yield* appManifest({
        name: "Notes releases",
        url: "https://notes.example",
        redirectUrl: "https://notes.example/github/created",
        permissions: { actions: "write" },
        public: false,
        state: "abc123",
      })
      assert.strictEqual(form.action, "https://github.com/settings/apps/new?state=abc123")
      const manifest = yield* decodeJson(form.manifest)
      assert.deepStrictEqual(manifest, {
        name: "Notes releases",
        url: "https://notes.example",
        redirect_url: "https://notes.example/github/created",
        public: false,
        default_permissions: { actions: "write" },
      })
    }),
  )

  it("links to the page that installs an app", () => {
    assert.strictEqual(
      installLink(AppSlug.make("notes-releases")),
      "https://github.com/apps/notes-releases/installations/new",
    )
    // A slug is one segment of the path: never `..`, or anything a URL encodes.
    for (const slug of ["..", "a/b", "", "\uD800"]) {
      assert.isFalse(Schema.is(AppSlug)(slug), slug)
    }
  })
})

describe("convertManifest", () => {
  it.effect("gets the app GitHub created for a code, unauthenticated, its secrets redacted", () =>
    Effect.gen(function* () {
      const code = "a180b1a3d263c81bc6441d7b990bae27d4c10679"
      const github = fakeGitHub({
        [`POST /app-manifests/${code}/conversions`]: [
          { status: 201, body: manifestConversionJson({ pem, webhookSecret: "test-webhook-secret-not-real" }) },
        ],
      })
      const created = yield* convertManifest(code).pipe(Effect.provide(github.layer))

      assert.deepStrictEqual(
        { id: created.id, slug: created.slug, name: created.name, url: created.url, clientId: created.clientId },
        {
          id: 123456,
          slug: "notes-releases",
          name: "Notes releases",
          url: "https://github.com/apps/notes-releases",
          clientId: "Iv23liTestClientNotReal",
        },
      )
      assert.isTrue(Redacted.isRedacted(created.privateKey))
      assert.strictEqual(Redacted.value(created.privateKey), pem)
      assert.strictEqual(Redacted.value(created.clientSecret), "test-client-secret-not-a-real-one")
      assert.strictEqual(
        created.webhookSecret === undefined ? undefined : Redacted.value(created.webhookSecret),
        "test-webhook-secret-not-real",
      )
      assert.strictEqual(github.asked[0]?.headers["authorization"], undefined)
    }),
  )

  it.effect("has no webhook secret when GitHub gives none", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({
        "POST /app-manifests/abc123/conversions": [
          { status: 201, body: manifestConversionJson({ pem, webhookSecret: null }) },
        ],
      })
      const created = yield* convertManifest("abc123").pipe(Effect.provide(github.layer))
      assert.isFalse("webhookSecret" in created)
    }),
  )

  it.effect("refuses a code GitHub doesn't take, and one that isn't a code, asking only about the first", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({})
      const refusals = yield* Effect.all([
        convertManifest("0000000000000000000000000000000000000000").pipe(Effect.flip),
        convertManifest("../../app").pipe(Effect.flip),
        convertManifest("a180b1a3/../../user").pipe(Effect.flip),
      ]).pipe(Effect.provide(github.layer))
      const notACode = {
        _tag: "GitHubRefused",
        reason: "That isn't a code GitHub sends back from a manifest",
      } as const
      assert.deepStrictEqual(refusals.map(factsOf), [
        { _tag: "GitHubRefused", reason: "Not Found" },
        notACode,
        notACode,
      ])
      assert.strictEqual(github.asked.length, 1)
    }),
  )

  it.effect("is unavailable, not refused, when GitHub fails", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({
        "POST /app-manifests/abc123/conversions": [{ status: 503, body: errorJson("Service Unavailable", 503) }],
      })
      const unavailable = yield* convertManifest("abc123").pipe(Effect.flip, Effect.provide(github.layer))
      assert.deepStrictEqual(factsOf(unavailable), { _tag: "GitHubUnavailable", reason: "Service Unavailable" })
    }),
  )

  it.effect("refuses a code GitHub can't convert, with its message", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({
        "POST /app-manifests/abc123/conversions": [{ status: 422, body: errorJson("Validation Failed", 422) }],
      })
      const refused = yield* convertManifest("abc123").pipe(Effect.flip, Effect.provide(github.layer))
      assert.deepStrictEqual(factsOf(refused), { _tag: "GitHubRefused", reason: "Validation Failed" })
    }),
  )

  it.effect("keeps the code, which holds the app's secrets until converted, out of what it reports and traces", () =>
    Effect.gen(function* () {
      const github = fakeGitHub({
        "POST /app-manifests/abc123secret/conversions": [
          { status: 400, body: errorJson("Problems parsing JSON", 400) },
          "connection lost",
        ],
      })
      // A tracer that keeps every span it makes.
      const spans: Array<Tracer.NativeSpan> = []
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options)
          spans.push(span)
          return span
        },
      })
      const exit = yield* convertManifest("abc123secret").pipe(
        Effect.provide(github.layer),
        Effect.withTracer(tracer),
        Effect.exit,
      )
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      assert.include(typeof defect === "string" ? defect : "", "/app-manifests/{code}/conversions")
      assert.notInclude(typeof defect === "string" ? defect : "", "abc123secret")
      const unavailable = yield* convertManifest("abc123secret").pipe(
        Effect.provide(github.layer),
        Effect.withTracer(tracer),
        Effect.flip,
      )
      assert.deepStrictEqual(factsOf(unavailable), { _tag: "GitHubUnavailable", reason: "GitHub didn't answer" })
      // Its request is a client span with the path's template, and no span holds the code: not its
      // name, attributes, or the error it ended with, as Effect's OTLP exporter writes it.
      const requests = spans.filter((span) => span.kind === "client")
      assert.deepStrictEqual(
        requests.map((span) => [span.attributes.get("url.template"), span.attributes.get("http.response.status_code")]),
        [
          ["/app-manifests/{code}/conversions", 400],
          ["/app-manifests/{code}/conversions", undefined],
        ],
      )
      const traced: Array<string> = []
      for (const span of spans) {
        traced.push(span.name, ...Array.from(span.attributes.values(), String))
        if (span.status._tag === "Ended" && Exit.isFailure(span.status.exit)) {
          for (const error of Cause.prettyErrors(span.status.exit.cause)) {
            traced.push(error.message, error.stack ?? "")
          }
        }
      }
      assert.isFalse(
        traced.some((text) => text.includes("abc123secret")),
        traced.join(", "),
      )
    }),
  )
})

describe("appManifest, for an organization", () => {
  it.effect("dies on a login that isn't one, which would send the form elsewhere", () =>
    Effect.gen(function* () {
      for (const organization of ["..", "octo/org", ""]) {
        const options = {
          name: "Notes releases",
          url: "https://notes.example",
          redirectUrl: "https://notes.example/github/created",
          permissions: {},
          public: false,
          state: "state",
          organization,
        }
        const exit = yield* appManifest(options).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause), organization)
      }
    }),
  )
})
