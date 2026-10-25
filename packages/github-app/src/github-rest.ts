import { Clock, Duration, Effect, Option, Schema } from "effect"
import type { Redacted } from "effect"
import { Headers, HttpClient, HttpClientRequest } from "effect/http"

import { ErrorAnswer, RateLimitHeaders } from "./answers.ts"
import { GitHubAppCredentialsRefused, GitHubForbidden, GitHubUnavailable } from "./github-errors.ts"

// GitHub's REST API as the app asks it: one request with the headers GitHub
// asks for, its answer read whole within 15 seconds, and what a status means when the caller doesn't
// read it itself.

const api = "https://api.github.com"
const apiVersion = "2022-11-28"
// GitHub refuses a request without a User-Agent, and asks for the application's name in it.
const userAgent = "@bagatka/github-app"
const answerTimeout = Duration.seconds(15)

/** One request to GitHub's REST API. */
export interface Question {
  readonly method: "GET" | "POST" | "PATCH"
  /** The path under `https://api.github.com`, its segments already safe. */
  readonly path: string
  /**
   * The path as messages and traces show it, when it holds a secret:
   * `/app-manifests/{code}/conversions`. The request's span is then this package's, with the path as
   * `url.template`, since Effect's would export the URL.
   */
  readonly shownAs?: string
  readonly urlParams?: Readonly<Record<string, string | number>>
  /** The bearer: a token or the app's JWT; absent for a request GitHub takes unauthenticated. */
  readonly token?: Redacted.Redacted
  /** A JSON body, for a POST or a PATCH. */
  readonly body?: Schema.JsonObject
}

/** What GitHub answered: the method and path asked, its status, headers, and body as text. */
export interface Answer {
  readonly method: string
  readonly path: string
  readonly status: number
  readonly headers: Headers.Headers
  readonly body: string
}

/** Asks GitHub `question` once: unavailable when no answer comes, or none in 15 seconds. */
export const ask = Effect.fnUntraced(function* (client: HttpClient.HttpClient, question: Question) {
  const unauthorized = HttpClientRequest.make(question.method)(`${api}${question.path}`).pipe(
    HttpClientRequest.setUrlParams(question.urlParams ?? {}),
    HttpClientRequest.setHeaders({
      accept: "application/vnd.github+json",
      "x-github-api-version": apiVersion,
      "user-agent": userAgent,
    }),
  )
  const authorized =
    question.token === undefined ? unauthorized : HttpClientRequest.bearerToken(unauthorized, question.token)
  const request = yield* withBody(authorized, question.body)
  // A failure becomes GitHubUnavailable before a span of this package's ends, since a tracer exports
  // the error a span ends with, and HttpClientError's message holds the URL.
  const answered = client.execute(request).pipe(
    Effect.flatMap((response) =>
      Effect.map(response.text, (body): Answer => ({
        method: question.method,
        path: question.shownAs ?? question.path,
        status: response.status,
        headers: response.headers,
        body,
      })),
    ),
    Effect.timeout(answerTimeout),
    Effect.catchTags({
      TimeoutError: () => Effect.fail(new GitHubUnavailable({ reason: "GitHub didn't answer in 15 seconds" })),
      HttpClientError: () => Effect.fail(new GitHubUnavailable({ reason: "GitHub didn't answer" })),
    }),
  )
  return yield* question.shownAs === undefined
    ? answered
    : answered.pipe(
        Effect.tap((answer) =>
          Effect.annotateCurrentSpan({
            "http.response.status_code": answer.status,
            ...(answer.status >= 400 ? { "error.type": String(answer.status) } : {}),
          }),
        ),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.withSpan(question.method, {
          kind: "client",
          attributes: {
            "http.request.method": question.method,
            "server.address": "api.github.com",
            "server.port": 443,
            "url.scheme": "https",
            "url.template": question.shownAs,
          },
        }),
      )
})

const withBody = (request: HttpClientRequest.HttpClientRequest, body: Schema.JsonObject | undefined) =>
  body === undefined ? Effect.succeed(request) : HttpClientRequest.bodyJson(request, body).pipe(Effect.orDie)

/**
 * What an answer means when the method asking doesn't read its status: the credentials refused (a
 * 401 after a JWT signed again, or after a token just issued), forbidden, unavailable, or, for a
 * status GitHub doesn't document there, a defect.
 */
export const failure = Effect.fnUntraced(function* (answer: Answer) {
  const reason = yield* reasonOf(answer)
  if (answer.status === 401) {
    return yield* new GitHubAppCredentialsRefused({ reason })
  }
  if (answer.status === 403 || answer.status === 429) {
    const limited = yield* rateLimitedFor(answer, reason)
    if (Option.isSome(limited)) {
      return yield* new GitHubUnavailable({ reason, retryAfter: limited.value })
    }
    return yield* new GitHubForbidden({ reason })
  }
  if (answer.status >= 500) {
    return yield* new GitHubUnavailable({ reason })
  }
  return yield* Effect.die(`GitHub answered ${answer.method} ${answer.path} with ${answer.status}: ${reason}`)
})

/**
 * GitHub's JSON answer decoded with `schema`. An answer of another shape is a defect that says what
 * differs, never a default.
 */
export const read = <S extends Schema.Decoder<unknown>>(schema: S, answer: Answer) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(answer.body).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(
        `GitHub's answer to ${answer.method} ${answer.path} isn't shaped as its documentation says: ${error.message}`,
      ),
    ),
  )

/**
 * `read`, for an answer that holds secrets, such as a token or a private key: an answer of another
 * shape is a defect that leaves out what differs, since saying so could show a secret.
 */
export const readSecrets = <S extends Schema.Decoder<unknown>>(schema: S, answer: Answer) =>
  Schema.decodeEffect(Schema.fromJsonString(schema))(answer.body).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.die(
        `GitHub's answer to ${answer.method} ${answer.path} isn't shaped as its documentation says; what differs is left out, as the answer holds secrets`,
      ),
    ),
  )

/** GitHub's message in an answer, or the status alone when it sent none, as a 5xx may not. */
export const reasonOf = (answer: Answer) =>
  Schema.decodeEffect(ErrorAnswer)(answer.body).pipe(
    Effect.map((error) => error.message),
    Effect.orElseSucceed(() => `HTTP ${answer.status}`),
  )

// When a 403 or 429 is a rate limit, how long to wait: `retry-after`, until the limit's reset when
// none are left, else a minute, as GitHub's documentation asks. None for a refusal.
const rateLimitedFor = Effect.fnUntraced(function* (answer: Answer, reason: string) {
  const headers = yield* Schema.decodeUnknownEffect(RateLimitHeaders)(answer.headers).pipe(
    Effect.catchTag("SchemaError", (error) =>
      Effect.die(`GitHub's rate-limit headers aren't what it documents: ${error.message}`),
    ),
  )
  const now = yield* Clock.currentTimeMillis
  const retryAfter = headers["retry-after"]
  if (retryAfter !== undefined) {
    return Option.some(Headers.retryAfterDelay(retryAfter, now))
  }
  const exhausted = headers["x-ratelimit-remaining"] === "0"
  const resetsAt = headers["x-ratelimit-reset"]
  if (exhausted && resetsAt !== undefined) {
    return Option.some(Duration.millis(Math.max(0, resetsAt * 1000 - now)))
  }
  const limited = exhausted || answer.status === 429 || /rate limit/i.test(reason)
  return limited ? Option.some(Duration.minutes(1)) : Option.none<Duration.Duration>()
})
