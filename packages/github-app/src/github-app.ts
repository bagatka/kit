import type { JwtCrypto } from "@bagatka/jwt"
import { importSigningKey, signJwt } from "@bagatka/jwt"
import {
  Cache,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  SynchronizedRef,
} from "effect"
import { HttpClient } from "effect/http"

import {
  InstallationAnswer,
  InstallationRepositoriesAnswer,
  InstallationsAnswer,
  InstallationTokenAnswer,
} from "./answers.ts"
import type { Failure } from "./github-errors.ts"
import { GitHubAppCredentialsInvalid, GitHubRefused } from "./github-errors.ts"
import type { Question } from "./github-rest.ts"
import { ask, failure, read, readSecrets, reasonOf } from "./github-rest.ts"
import type { InstallationId } from "./installation-id.ts"
import type { Repository } from "./repository.ts"

/**
 * A GitHub App, as GitHub gives it: its ID, such as 123456, or its client ID, such as
 * `Iv23li…`, which GitHub recommends, either the issuer of its JWTs; and a private key GitHub
 * generated for it, the PEM's text: PKCS #1 (`BEGIN RSA PRIVATE KEY`), as GitHub gives it, or PKCS #8.
 */
export interface GitHubAppCredentials {
  readonly appId: number | string
  readonly privateKey: Redacted.Redacted
}

/**
 * The part of the platform's Web Crypto, `crypto.subtle`, that the app's JWTs are signed with: the
 * one `@bagatka/jwt` takes.
 */
export type GitHubAppCrypto = JwtCrypto

// An app's ID, a number, or its client ID, such as `Iv23liDTaK7bN3Kd0Qxw`.
const isAppId = (appId: number | string): boolean =>
  typeof appId === "number" ? Number.isSafeInteger(appId) && appId > 0 : /^[A-Za-z0-9.]{1,64}$/.test(appId)

/** Where a GitHub App is installed: on one account, reaching all its repositories or those chosen. */
export interface Installation {
  readonly id: InstallationId
  /** The login of the account it is installed on. */
  readonly account: string
  readonly accountType: "User" | "Organization"
  /** Whether it reaches every repository of the account, now and later, or those chosen. */
  readonly repositories: "all" | "selected"
  /** Its settings on GitHub. */
  readonly url: string
}

/** A token GitHub issued, and when it expires: an installation's, an hour after it was issued. */
export interface IssuedToken {
  readonly token: Redacted.Redacted
  readonly expiresAt: DateTime.Utc
}

// GitHub takes an app's JWT for at most 10 minutes ahead, and asks for its `iat` 60 s in the past,
// against clocks that drift. Ours expires 9 minutes ahead, so a clock a minute fast still passes,
// and is signed again after 8.
const jwtExpiresIn = Duration.toSeconds(Duration.minutes(9))
const jwtKept = Duration.toMillis(Duration.minutes(8))
// An installation token is kept until 5 minutes before it expires, so none is sent about to.
const tokenMargin = Duration.toMillis(Duration.minutes(5))
// Which installation reaches a repository is kept a minute: enough for the requests of one task,
// short enough that a reinstalled app is found again soon. Not being installed isn't kept.
const installationKept = Duration.minutes(1)
// One page of installations and of an installation's repositories, GitHub's largest.
const pageSize = 100
// Bounds on what is kept: more installations, or repositories asked about, than a product reaches.
const entriesKept = 1000

/**
 * A GitHub App: where it is installed, the repositories each installation reaches, and the
 * installation tokens it acts with on GitHub's API.
 */
export class GitHubApp extends Context.Service<
  GitHubApp,
  {
    /**
     * The installation that reaches `repository`; none when the app isn't installed on its account,
     * the installation doesn't reach it, or it doesn't exist. One request, with the app's JWT.
     */
    readonly installationOf: (repository: Repository) => Effect.Effect<Option.Option<Installation>, Failure>
    /** The app's installations: at most 100, the first page GitHub lists. One request. */
    readonly installations: Effect.Effect<ReadonlyArray<Installation>, Failure>
    /**
     * The repositories the installation reaches: at most 100, the first page GitHub lists. One
     * request, with its token. Refused with 404 for an installation of another app, or none.
     */
    readonly repositoriesOf: (installation: InstallationId) => Effect.Effect<ReadonlyArray<Repository>, Failure>
    /**
     * A token to act as the installation, with every permission and repository it was granted. A
     * token is kept and given again until 5 minutes before it expires, then a new one is issued
     * (one request); calls at the same time share one. Refused with 404 for an installation of
     * another app, or none; forbidden (`GitHubForbidden`) for one suspended.
     */
    readonly installationToken: (installation: InstallationId) => Effect.Effect<IssuedToken, Failure>
    /**
     * A token to act on `repository` alone, with every permission the installation that reaches it
     * was granted: `installationOf`, kept a minute, then a token GitHub limits to that repository,
     * kept as `installationToken` keeps one. Refused with 404, saying so, when the app isn't
     * installed on it.
     */
    readonly tokenFor: (repository: Repository) => Effect.Effect<IssuedToken, Failure>
  }
>()("@bagatka/github-app/github-app/GitHubApp") {
  /**
   * A client of the app with `credentials`, signing its JWTs with `crypto` (`crypto.subtle`), on
   * the `HttpClient` the host provides, with caches of its own: for an app whose credentials come
   * while a product runs, as from `convertManifest`, made once per app and kept. The key is
   * imported once, and a JWT signed once and kept 8 minutes, shared by requests sent together.
   * Fails with `GitHubAppCredentialsInvalid` when the credentials can't sign JWTs GitHub takes.
   */
  static readonly make = (
    credentials: GitHubAppCredentials,
    crypto: GitHubAppCrypto,
  ): Effect.Effect<GitHubApp["Service"], GitHubAppCredentialsInvalid, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      if (!isAppId(credentials.appId)) {
        return yield* new GitHubAppCredentialsInvalid({
          reason: "The app's ID is a whole number from 1, or a client ID of letters, digits and dots",
        })
      }
      const key = yield* importSigningKey(crypto, "RS256", credentials.privateKey).pipe(
        Effect.mapError((invalid) => new GitHubAppCredentialsInvalid({ reason: invalid.reason })),
      )
      const client = yield* HttpClient.HttpClient
      const signed = yield* SynchronizedRef.make(
        Option.none<{ readonly jwt: Redacted.Redacted; readonly at: number }>(),
      )

      // The app's JWT (RS256): `iat` 60 s in the past, `exp` 9 minutes ahead, `iss` the app: the one
      // kept, unless it is 8 minutes old or is `stale`, which GitHub refused. One signing at a time,
      // so requests sent together share one.
      const jwt = (stale: Redacted.Redacted | undefined) =>
        SynchronizedRef.modifyEffect(signed, (previous) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            if (Option.isSome(previous) && previous.value.jwt !== stale && now - previous.value.at < jwtKept) {
              return [previous.value.jwt, previous] as const
            }
            const seconds = Math.floor(now / 1000)
            const token = yield* signJwt(
              key,
              { typ: "JWT" },
              { iat: seconds - 60, exp: seconds + jwtExpiresIn, iss: credentials.appId },
            )
            const fresh = Redacted.make(token)
            return [fresh, Option.some({ jwt: fresh, at: now })] as const
          }),
        )

      // `question` asked with the app's JWT; one GitHub refuses (401) is signed again, once, and the
      // question asked once more. A 401 means GitHub did nothing, so asking again is safe.
      const askAsApp = Effect.fnUntraced(function* (question: Omit<Question, "token">) {
        const bearer = yield* jwt(undefined)
        const first = yield* ask(client, { ...question, token: bearer })
        if (first.status !== 401) {
          return first
        }
        return yield* ask(client, { ...question, token: yield* jwt(bearer) })
      })

      const installationOf = Effect.fn("GitHubApp.installationOf")(function* (repository: Repository) {
        const answer = yield* askAsApp({ method: "GET", path: `/repos/${repository}/installation` })
        if (answer.status === 200) {
          const found = yield* read(InstallationAnswer, answer)
          return Option.some(installationFrom(found))
        }
        if (answer.status === 404) {
          return Option.none<Installation>()
        }
        return yield* failure(answer)
      })

      const installations = Effect.gen(function* () {
        const answer = yield* askAsApp({ method: "GET", path: "/app/installations", urlParams: { per_page: pageSize } })
        if (answer.status !== 200) {
          return yield* failure(answer)
        }
        const found = yield* read(InstallationsAnswer, answer)
        return found.map(installationFrom)
      }).pipe(Effect.withSpan("GitHubApp.installations"))

      // A new token for the installation, for `repository` alone when one is given, and how long to
      // keep it: until 5 minutes before it expires, or not at all when that has passed, as on a clock
      // far behind GitHub's.
      const issue = Effect.fnUntraced(function* (installation: InstallationId, repository: Repository | undefined) {
        const name = repository?.slice(repository.indexOf("/") + 1)
        const answer = yield* askAsApp({
          method: "POST",
          path: `/app/installations/${installation}/access_tokens`,
          ...(name === undefined ? {} : { body: { repositories: [name] } }),
        })
        if (answer.status === 404) {
          return yield* refusedInstallation(installation)
        }
        // GitHub's answer for a repository the installation doesn't reach.
        if (answer.status === 422) {
          const reason = yield* reasonOf(answer)
          return yield* new GitHubRefused({ reason })
        }
        if (answer.status !== 201) {
          return yield* failure(answer)
        }
        const issued = yield* readSecrets(InstallationTokenAnswer, answer)
        const now = yield* Clock.currentTimeMillis
        const keepFor = DateTime.toEpochMillis(issued.expires_at) - tokenMargin - now
        return {
          issued: { token: issued.token, expiresAt: issued.expires_at },
          keepFor: Duration.millis(Math.max(0, keepFor)),
        }
      })
      const tokens = yield* Cache.makeWith((installation: InstallationId) => issue(installation, undefined), {
        capacity: entriesKept,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.keepFor : Duration.zero),
      })

      const installationToken = Effect.fn("GitHubApp.installationToken")(function* (installation: InstallationId) {
        const token = yield* Cache.get(tokens, installation)
        return token.issued
      })

      const reaching = yield* Cache.makeWith(installationOf, {
        capacity: entriesKept,
        timeToLive: (exit) => (Exit.isSuccess(exit) && Option.isSome(exit.value) ? installationKept : Duration.zero),
      })

      // A token for `repository` alone, from the installation that reaches it.
      const issueFor = Effect.fnUntraced(function* (repository: Repository) {
        const installation = yield* Cache.get(reaching, repository)
        if (Option.isNone(installation)) {
          return yield* new GitHubRefused({
            reason: `The GitHub App isn't installed on ${repository}: install it on the repository's account, with access to the repository`,
          })
        }
        return yield* issue(installation.value.id, repository)
      })
      const repositoryTokens = yield* Cache.makeWith(issueFor, {
        capacity: entriesKept,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.keepFor : Duration.zero),
      })

      const tokenFor = Effect.fn("GitHubApp.tokenFor")(function* (repository: Repository) {
        const token = yield* Cache.get(repositoryTokens, repository)
        return token.issued
      })

      const repositoriesOf = Effect.fn("GitHubApp.repositoriesOf")(function* (installation: InstallationId) {
        const question = {
          method: "GET",
          path: "/installation/repositories",
          urlParams: { per_page: pageSize },
        } as const
        const kept = yield* Cache.get(tokens, installation)
        const first = yield* ask(client, { ...question, token: kept.issued.token })
        // A token GitHub revoked before it expires, as when the app was uninstalled and installed
        // again, is issued again, once.
        const answer =
          first.status === 401
            ? yield* Cache.invalidate(tokens, installation).pipe(
                Effect.andThen(Cache.get(tokens, installation)),
                Effect.flatMap((renewed) => ask(client, { ...question, token: renewed.issued.token })),
              )
            : first
        if (answer.status !== 200) {
          return yield* failure(answer)
        }
        const found = yield* read(InstallationRepositoriesAnswer, answer)
        return found.repositories.map((repository) => repository.full_name)
      })

      return GitHubApp.of({ installationOf, installations, repositoriesOf, installationToken, tokenFor })
    })

  /** The app with `credentials`, as `make` builds it, for credentials known when the host starts. */
  static readonly layer = (
    credentials: GitHubAppCredentials,
    crypto: GitHubAppCrypto,
  ): Layer.Layer<GitHubApp, GitHubAppCredentialsInvalid, HttpClient.HttpClient> =>
    Layer.effect(GitHubApp, GitHubApp.make(credentials, crypto))
}

const refusedInstallation = (installation: InstallationId) =>
  Effect.fail(new GitHubRefused({ reason: `GitHub has no installation ${installation} of this app` }))

const installationFrom = (answer: InstallationAnswer): Installation => ({
  id: answer.id,
  account: answer.account.login,
  accountType: answer.target_type,
  repositories: answer.repository_selection,
  url: answer.html_url,
})
