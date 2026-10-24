import { assert, describe, it } from "@effect/vitest"
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"

import type { GitHubAppCredentials, GitHubRefused, GitHubUnavailable } from "../src/index.ts"
import { GitHubApp, InstallationId, Repository } from "../src/index.ts"
import type { FakeAnswer } from "./fake-github.ts"
import { factsOf, fakeGitHub } from "./fake-github.ts"
import { errorJson, installationJson, installationTokenJson, repositoryJson } from "./github-answers.ts"
import { newAppKey, openJwt, subtle } from "./web-crypto.ts"

const repository = Repository.make("octocat/Hello-World")
const now = DateTime.makeUnsafe("2026-10-22T10:00:00Z")
const nowSeconds = DateTime.toEpochMillis(now) / 1000

const credentialsOf = (privateKey: string): GitHubAppCredentials => ({
  appId: 123456,
  privateKey: Redacted.make(privateKey),
})

// Runs `program` with the app, its API answered by `github`, at `now`.
const withApp = <A, E>(
  github: ReturnType<typeof fakeGitHub>,
  credentials: GitHubAppCredentials,
  program: Effect.Effect<A, E, GitHubApp>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(now))
    return yield* program.pipe(Effect.provide(GitHubApp.layer(credentials, subtle).pipe(Layer.provide(github.layer))))
  })

const tokenAnswer = (token: string, expiresAt: string) => ({
  status: 201,
  body: installationTokenJson(token, expiresAt),
})

const installedOnOrganization = {
  status: 200,
  body: installationJson({ id: 42, login: "octocat", type: "Organization", selection: "selected" }),
}

// The rate-limit headers GitHub sends with every answer: `remaining` requests left in the window,
// which resets at 10:30.
const rateLimit = (remaining: number) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-used": String(5000 - remaining),
  "x-ratelimit-reset": String(nowSeconds + 1800),
  "x-ratelimit-resource": "core",
})

// What a case of these tests asks the app, and what its fake GitHub answers.
interface Asking<E> {
  readonly answers: Readonly<Record<string, ReadonlyArray<FakeAnswer>>>
  readonly call: (app: GitHubApp["Service"]) => Effect.Effect<unknown, E>
}

describe("GitHubApp", () => {
  it.effect("signs its JWT with RS256 as its ID or client ID, from a PKCS #1 key, as GitHub gives it, or PKCS #8", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      for (const [pem, appId, issuer] of [
        [key.pkcs1, 123456, "123456"],
        [key.pkcs8, "Iv23liTestClientNotReal", '"Iv23liTestClientNotReal"'],
      ] as const) {
        const github = fakeGitHub({
          "GET /app/installations": [
            {
              status: 200,
              body: [
                installationJson({ id: 42, login: "octocat", type: "Organization", selection: "selected" }),
                installationJson({ id: 43, login: "monalisa", type: "User", selection: "all" }),
              ],
            },
          ],
        })
        const installations = yield* withApp(
          github,
          { appId, privateKey: Redacted.make(pem) },
          Effect.gen(function* () {
            const app = yield* GitHubApp
            return yield* app.installations
          }),
        )
        assert.deepStrictEqual(installations, [
          {
            id: InstallationId.make(42),
            account: "octocat",
            accountType: "Organization",
            repositories: "selected",
            url: "https://github.com/organizations/octocat/settings/installations/42",
          },
          {
            id: InstallationId.make(43),
            account: "monalisa",
            accountType: "User",
            repositories: "all",
            url: "https://github.com/settings/installations/43",
          },
        ])

        const question = github.asked[0]
        const authorization = question?.headers["authorization"] ?? ""
        assert.isTrue(authorization.startsWith("Bearer "))
        // What GitHub asks every request to say: the media type, the API's version, and who asks.
        assert.deepInclude(question?.headers ?? {}, {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "@bagatka/github-app",
        })
        assert.strictEqual(question?.url.searchParams.get("per_page"), "100")
        const jwt = yield* openJwt(authorization.slice("Bearer ".length), key.publicKey)
        assert.isTrue(jwt.verifies)
        assert.strictEqual(jwt.header, '{"alg":"RS256","typ":"JWT"}')
        // Issued 60 s in the past, expiring 9 minutes ahead: within GitHub's 10.
        assert.strictEqual(jwt.claims, `{"iat":${nowSeconds - 60},"exp":${nowSeconds + 540},"iss":${issuer}}`)
      }
    }),
  )

  it.effect("signs one JWT for requests sent together, and keeps it 8 minutes", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({ "GET /app/installations": [{ status: 200, body: [] }] })
      yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          yield* Effect.all(
            Array.from({ length: 6 }, () => app.installations),
            { concurrency: "unbounded" },
          )
          yield* TestClock.adjust("7 minutes")
          yield* app.installations
          yield* TestClock.adjust("1 minute")
          yield* app.installations
        }),
      )
      const bearers = github.asked.map((question) => question.headers["authorization"])
      assert.strictEqual(new Set(bearers.slice(0, 7)).size, 1)
      assert.notStrictEqual(bearers[7], bearers[0])
    }),
  )

  it.effect("issues an installation token, keeps it, and issues another 5 minutes before it expires", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({
        "POST /app/installations/42/access_tokens": [
          tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z"),
          tokenAnswer("ghs_test-token-two-not-real", "2026-10-22T11:56:00Z"),
        ],
      })
      const [first, together, kept, renewed] = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          const issued = yield* app.installationToken(InstallationId.make(42))
          const atOnce = yield* Effect.all(
            [app.installationToken(InstallationId.make(42)), app.installationToken(InstallationId.make(42))],
            {
              concurrency: "unbounded",
            },
          )
          yield* TestClock.adjust("54 minutes")
          const later = yield* app.installationToken(InstallationId.make(42))
          yield* TestClock.adjust("2 minutes")
          const nearExpiry = yield* app.installationToken(InstallationId.make(42))
          return [issued, atOnce, later, nearExpiry] as const
        }),
      )
      assert.strictEqual(Redacted.value(first.token), "ghs_test-token-one-not-real")
      assert.deepStrictEqual(first.expiresAt, DateTime.makeUnsafe("2026-10-22T11:00:00Z"))
      assert.deepStrictEqual(
        together.map((issued) => Redacted.value(issued.token)),
        ["ghs_test-token-one-not-real", "ghs_test-token-one-not-real"],
      )
      assert.strictEqual(Redacted.value(kept.token), "ghs_test-token-one-not-real")
      assert.strictEqual(Redacted.value(renewed.token), "ghs_test-token-two-not-real")
      assert.deepStrictEqual(renewed.expiresAt, DateTime.makeUnsafe("2026-10-22T11:56:00Z"))
      assert.strictEqual(github.asked.length, 2)
      assert.isTrue(github.asked.every((question) => question.method === "POST"))
      // No repositories named: the token reaches every one the installation does.
      assert.isTrue(github.asked.every((question) => question.body === undefined))
    }),
  )

  it.effect("gives the token of the installation that reaches a repository, and keeps which one it is", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({
        "GET /repos/octocat/Hello-World/installation": [installedOnOrganization],
        "POST /app/installations/42/access_tokens": [
          tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z"),
        ],
      })
      const [first, second] = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          return yield* Effect.all([app.tokenFor(repository), app.tokenFor(repository)])
        }),
      )
      assert.strictEqual(Redacted.value(first.token), "ghs_test-token-one-not-real")
      assert.deepStrictEqual(first.expiresAt, DateTime.makeUnsafe("2026-10-22T11:00:00Z"))
      assert.strictEqual(Redacted.value(second.token), "ghs_test-token-one-not-real")
      assert.deepStrictEqual(
        github.asked.map((question) => `${question.method} ${question.url.pathname}`),
        ["GET /repos/octocat/Hello-World/installation", "POST /app/installations/42/access_tokens"],
      )
      // Limited to the repository asked for, not every one the installation reaches.
      assert.deepStrictEqual(github.asked[1]?.body, { repositories: ["Hello-World"] })
    }),
  )

  it.effect("refuses a repository the app isn't installed on, and asks again the next time", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({})
      const [refused, again] = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          const found = yield* app.installationOf(repository)
          assert.deepStrictEqual(found, Option.none())
          return yield* Effect.all([
            app.tokenFor(repository).pipe(Effect.flip),
            app.tokenFor(repository).pipe(Effect.flip),
          ])
        }),
      )
      assert.deepStrictEqual(factsOf(refused), {
        _tag: "GitHubRefused",
        status: 404,
        reason:
          "The GitHub App isn't installed on octocat/Hello-World: install it on the repository's account, with access to the repository",
      })
      assert.strictEqual(again._tag, "GitHubRefused")
      assert.strictEqual(github.asked.length, 3)
    }),
  )

  it.effect("lists the repositories an installation reaches, with its token", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({
        "POST /app/installations/42/access_tokens": [
          tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z"),
        ],
        "GET /installation/repositories": [
          {
            status: 200,
            body: {
              total_count: 2,
              repository_selection: "selected",
              repositories: [repositoryJson, { ...repositoryJson, name: "notes-ios", full_name: "octocat/notes-ios" }],
            },
          },
        ],
      })
      const repositories = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          return yield* app.repositoriesOf(InstallationId.make(42))
        }),
      )
      assert.deepStrictEqual(repositories, [repository, Repository.make("octocat/notes-ios")])
      assert.strictEqual(github.asked[1]?.headers["authorization"], "Bearer ghs_test-token-one-not-real")
      assert.strictEqual(github.asked[1]?.url.searchParams.get("per_page"), "100")
    }),
  )

  it.effect("refuses an installation GitHub doesn't have", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({})
      const missing = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          return yield* app.installationToken(InstallationId.make(7)).pipe(Effect.flip)
        }),
      )
      assert.deepStrictEqual(factsOf(missing), {
        _tag: "GitHubRefused",
        status: 404,
        reason: "GitHub has no installation 7 of this app",
      })
    }),
  )

  it.effect("fails to build, sending nothing, with credentials that can't sign GitHub's JWTs", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const silent = fakeGitHub({})
      for (const [credentials, wrong] of [
        [credentialsOf("-----BEGIN RSA PRIVATE KEY-----\nbm90IGEga2V5\n-----END RSA PRIVATE KEY-----"), "key"],
        [{ ...credentialsOf(key.pkcs1), appId: 0 }, "ID"],
        [{ ...credentialsOf(key.pkcs1), appId: "Iv23 li/../x" }, "ID"],
      ] as const) {
        const failure = yield* GitHubApp.make(credentials, subtle).pipe(Effect.provide(silent.layer), Effect.flip)
        assert.strictEqual(failure._tag, "GitHubAppCredentialsInvalid")
        // Its reason says which is wrong, and its message carries the reason.
        assert.include(failure.reason, wrong)
        assert.include(failure.message, failure.reason)
      }
      assert.strictEqual(silent.asked.length, 0)
    }),
  )

  it.effect("makes a client while running, for credentials that come later, each with caches of its own", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const github = fakeGitHub({
        "POST /app/installations/42/access_tokens": [
          tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z"),
          tokenAnswer("ghs_test-token-two-not-real", "2026-10-22T11:00:00Z"),
        ],
      })
      yield* TestClock.setTime(DateTime.toEpochMillis(now))
      const tokens = yield* Effect.gen(function* () {
        const one = yield* GitHubApp.make(credentialsOf(key.pkcs1), subtle)
        const other = yield* GitHubApp.make(credentialsOf(key.pkcs8), subtle)
        return yield* Effect.all([
          one.installationToken(InstallationId.make(42)),
          one.installationToken(InstallationId.make(42)),
          other.installationToken(InstallationId.make(42)),
          other.installationToken(InstallationId.make(42)),
        ])
      }).pipe(Effect.provide(github.layer))
      assert.deepStrictEqual(
        tokens.map((issued) => Redacted.value(issued.token)),
        [
          "ghs_test-token-one-not-real",
          "ghs_test-token-one-not-real",
          "ghs_test-token-two-not-real",
          "ghs_test-token-two-not-real",
        ],
      )
      assert.strictEqual(github.asked.length, 2)
    }),
  )

  it.effect("refuses a token for a repository its installation doesn't reach, keeping which installation it is", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const unreachable =
        "There is at least one repository that does not exist or is not accessible to the parent installation."
      const github = fakeGitHub({
        "GET /repos/octocat/Hello-World/installation": [installedOnOrganization],
        "POST /app/installations/42/access_tokens": [{ status: 422, body: errorJson(unreachable, 422) }],
      })
      const refusals = yield* withApp(
        github,
        credentialsOf(key.pkcs1),
        Effect.gen(function* () {
          const app = yield* GitHubApp
          const first = yield* app.tokenFor(repository).pipe(Effect.flip)
          const again = yield* app.tokenFor(repository).pipe(Effect.flip)
          return [first, again]
        }),
      )
      const refused = { _tag: "GitHubRefused", status: 422, reason: unreachable } as const
      assert.deepStrictEqual(refusals.map(factsOf), [refused, refused])
      // The installation is asked for once; the refusal isn't kept, so each call asks for a token.
      assert.deepStrictEqual(
        github.asked.map((question) => `${question.method} ${question.url.pathname}`),
        [
          "GET /repos/octocat/Hello-World/installation",
          "POST /app/installations/42/access_tokens",
          "POST /app/installations/42/access_tokens",
        ],
      )
    }),
  )

  it.effect("tells a refusal from an outage, as GitHub's status and rate-limit headers say", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const issued = tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z")
      const secondary = "You have exceeded a secondary rate limit. Please wait a few minutes before you try again."
      const cases: ReadonlyArray<Asking<GitHubRefused | GitHubUnavailable> & { readonly facts: object }> = [
        // The app's JWT, refused.
        {
          answers: { "GET /app/installations": [{ status: 401, body: errorJson("Bad credentials", 401) }] },
          call: (app) => app.installations,
          facts: { _tag: "GitHubRefused", status: 401, reason: "Bad credentials" },
        },
        // An installation's token, revoked before it expires.
        {
          answers: {
            "POST /app/installations/42/access_tokens": [issued],
            "GET /installation/repositories": [{ status: 401, body: errorJson("Bad credentials", 401) }],
          },
          call: (app) => app.repositoriesOf(InstallationId.make(42)),
          facts: { _tag: "GitHubRefused", status: 401, reason: "Bad credentials" },
        },
        // A suspended installation: a 403 with requests left is a refusal.
        {
          answers: {
            "POST /app/installations/42/access_tokens": [
              { status: 403, body: errorJson("This installation has been suspended", 403), headers: rateLimit(4999) },
            ],
          },
          call: (app) => app.installationToken(InstallationId.make(42)),
          facts: { _tag: "GitHubRefused", status: 403, reason: "This installation has been suspended" },
        },
        // The window's requests spent: until it resets.
        {
          answers: {
            "GET /repos/octocat/Hello-World/installation": [
              {
                status: 403,
                body: errorJson("API rate limit exceeded for app ID 123456.", 403),
                headers: rateLimit(0),
              },
            ],
          },
          call: (app) => app.installationOf(repository),
          facts: {
            _tag: "GitHubUnavailable",
            reason: "API rate limit exceeded for app ID 123456.",
            retryAfter: "2026-10-22T10:30:00.000Z",
          },
        },
        // A secondary rate limit: after `retry-after`, when GitHub sends it, else a minute from now.
        {
          answers: {
            "GET /app/installations": [
              { status: 403, body: errorJson(secondary, 403), headers: { ...rateLimit(4999), "retry-after": "30" } },
            ],
          },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: secondary, retryAfter: "2026-10-22T10:00:30.000Z" },
        },
        // `retry-after` as an HTTP date, which HTTP allows: that time, or now for one gone by.
        {
          answers: {
            "GET /app/installations": [
              {
                status: 429,
                headers: { ...rateLimit(4999), "retry-after": "Thu, 22 Oct 2026 10:01:30 GMT" },
              },
            ],
          },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: "HTTP 429", retryAfter: "2026-10-22T10:01:30.000Z" },
        },
        {
          answers: {
            "GET /app/installations": [
              { status: 429, headers: { ...rateLimit(4999), "retry-after": "Thu, 22 Oct 2026 09:59:00 GMT" } },
            ],
          },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: "HTTP 429", retryAfter: "2026-10-22T10:00:00.000Z" },
        },
        {
          answers: {
            "GET /app/installations": [{ status: 403, body: errorJson(secondary, 403), headers: rateLimit(4999) }],
          },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: secondary, retryAfter: "2026-10-22T10:01:00.000Z" },
        },
        // A 429, even without a message.
        {
          answers: { "GET /app/installations": [{ status: 429, headers: rateLimit(4999) }] },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: "HTTP 429", retryAfter: "2026-10-22T10:01:00.000Z" },
        },
        // None left, and no time it resets: a minute from now.
        {
          answers: {
            "GET /app/installations": [
              {
                status: 403,
                body: errorJson("API rate limit exceeded for app ID 123456.", 403),
                headers: { "x-ratelimit-remaining": "0" },
              },
            ],
          },
          call: (app) => app.installations,
          facts: {
            _tag: "GitHubUnavailable",
            reason: "API rate limit exceeded for app ID 123456.",
            retryAfter: "2026-10-22T10:01:00.000Z",
          },
        },
        // A failure of GitHub's, its JSON without a message.
        {
          answers: { "GET /app/installations": [{ status: 500, body: {} }] },
          call: (app) => app.installations,
          facts: { _tag: "GitHubUnavailable", reason: "HTTP 500" },
        },
      ]
      for (const { answers, call, facts } of cases) {
        const error = yield* withApp(
          fakeGitHub(answers),
          credentialsOf(key.pkcs1),
          Effect.gen(function* () {
            const app = yield* GitHubApp
            return yield* call(app).pipe(Effect.asVoid, Effect.flip)
          }),
        )
        assert.deepStrictEqual(factsOf(error), facts)
        // What a log shows carries the reason.
        assert.include(error.message, error.reason)
      }
    }),
  )

  it.effect("is unavailable when GitHub doesn't answer in 15 s, or the connection fails", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      for (const answer of ["no answer", "connection lost"] as const) {
        const github = fakeGitHub({ "GET /app/installations": [answer] })
        const unavailable = yield* withApp(
          github,
          credentialsOf(key.pkcs1),
          Effect.gen(function* () {
            const app = yield* GitHubApp
            const asking = yield* Effect.forkChild(app.installations.pipe(Effect.flip))
            if (answer === "no answer") {
              yield* Deferred.await(github.waiting)
              yield* TestClock.adjust("15 seconds")
            }
            return yield* Fiber.join(asking)
          }),
        )
        assert.strictEqual(unavailable._tag, "GitHubUnavailable", answer)
      }
    }),
  )

  it.effect("dies on an answer of another shape, naming the request, and what differs unless it holds secrets", () =>
    Effect.gen(function* () {
      const key = yield* newAppKey
      const cases: ReadonlyArray<
        Asking<GitHubRefused | GitHubUnavailable> & {
          readonly says: ReadonlyArray<string>
          readonly never?: ReadonlyArray<string>
        }
      > = [
        // An installation on an enterprise, whose account has no login (not handled).
        {
          answers: {
            "GET /app/installations": [
              {
                status: 200,
                body: [
                  {
                    ...installationJson({ id: 44, login: "acme", type: "Organization", selection: "all" }),
                    account: { id: 3, slug: "acme", name: "Acme", html_url: "https://github.com/enterprises/acme" },
                    target_type: "Enterprise",
                  },
                ],
              },
            ],
          },
          call: (app) => app.installations,
          says: ["GET /app/installations", "login"],
        },
        // A repository without its full name.
        {
          answers: {
            "POST /app/installations/42/access_tokens": [
              tokenAnswer("ghs_test-token-one-not-real", "2026-10-22T11:00:00Z"),
            ],
            "GET /installation/repositories": [
              { status: 200, body: { total_count: 1, repositories: [{ id: 1296269, name: "Hello-World" }] } },
            ],
          },
          call: (app) => app.repositoriesOf(InstallationId.make(42)),
          says: ["GET /installation/repositories", "full_name"],
        },
        // A rate limit's `retry-after` neither in whole seconds nor an HTTP date.
        {
          answers: {
            "GET /app/installations": [{ status: 429, headers: { ...rateLimit(4999), "retry-after": "1.5" } }],
          },
          call: (app) => app.installations,
          says: ["retry-after"],
        },
        // A token without its expiry: what differs stays out, and the token with it.
        {
          answers: {
            "POST /app/installations/42/access_tokens": [
              { status: 201, body: { token: "ghs_test-token-one-not-real", repository_selection: "all" } },
            ],
          },
          call: (app) => app.installationToken(InstallationId.make(42)),
          says: ["POST /app/installations/42/access_tokens"],
          never: ["ghs_test-token-one-not-real", "expires_at"],
        },
      ]
      for (const { answers, call, says, never } of cases) {
        const exit = yield* withApp(
          fakeGitHub(answers),
          credentialsOf(key.pkcs1),
          Effect.gen(function* () {
            const app = yield* GitHubApp
            return yield* call(app)
          }),
        ).pipe(Effect.exit)
        const defect = Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.squash(exit.cause) : undefined
        const text = typeof defect === "string" ? defect : ""
        for (const said of says) {
          assert.include(text, said)
        }
        for (const unsaid of never ?? []) {
          assert.notInclude(text, unsaid)
        }
      }
    }),
  )
})

describe("Repository", () => {
  it("is an owner and one name after it, never a path that leads elsewhere", () => {
    for (const named of ["octocat/Hello-World", "acme/.github", "a/b"]) {
      assert.isTrue(Schema.is(Repository)(named), named)
    }
    for (const named of [
      "octocat",
      "octocat/",
      "/notes",
      "octocat/.",
      "octocat/..",
      "../octocat/notes",
      "octocat/notes/../../app",
      "octocat/notes/x",
      "octo cat/notes",
    ]) {
      assert.isFalse(Schema.is(Repository)(named), named)
    }
  })
})
