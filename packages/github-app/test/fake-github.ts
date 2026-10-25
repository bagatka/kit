import { Deferred, Duration, Effect, Layer, Schema } from "effect"
import type { HttpClientRequest } from "effect/http"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"

import type { GitHubAppCredentialsRefused, GitHubForbidden, GitHubRefused, GitHubUnavailable } from "../src/index.ts"
import { errorJson } from "./github-answers.ts"

// The runtime's `Response` and `TextDecoder`, which tests outside a runtime with its types can't
// name: the parts these tests use.
declare const Response: new (
  body: string | null,
  init: { readonly status: number; readonly headers?: Readonly<Record<string, string>> },
) => object
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

/** What the fake was asked: the method, the URL, the headers, and the JSON body, decoded. */
export interface Asked {
  readonly method: string
  // The parts of the runtime's URL these tests read, which they can't name.
  readonly url: { readonly pathname: string; readonly searchParams: { get(name: string): string | null } }
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/**
 * An answer of the fake's: a status, and a body to send as JSON; or none, ever; or a connection
 * that fails before any answer.
 */
export type FakeAnswer =
  | {
      readonly status: number
      readonly body?: unknown
      readonly headers?: Readonly<Record<string, string>>
    }
  | "no answer"
  | "connection lost"

/** GitHub's 404, which it answers for anything it doesn't show. */
export const notFound: FakeAnswer = { status: 404, body: errorJson("Not Found", 404) }

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

// The JSON a request carries, decoded; undefined for one without a body.
const bodyOf = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array"
    ? decodeJson(request.body.text ?? new TextDecoder().decode(request.body.body)).pipe(Effect.orDie)
    : Effect.void

/** An error's tag and fields, as plain data: `retryAfter` in seconds, when it has one. */
export const factsOf = (error: Failure) =>
  error._tag === "GitHubUnavailable"
    ? {
        _tag: error._tag,
        reason: error.reason,
        ...(error.retryAfter === undefined ? {} : { retryAfter: Duration.toSeconds(error.retryAfter) }),
      }
    : { _tag: error._tag, reason: error.reason }

/** Every way a request to GitHub can fail. */
export type Failure = GitHubAppCredentialsRefused | GitHubForbidden | GitHubRefused | GitHubUnavailable

/**
 * A fake GitHub: answers `"<METHOD> <path>"` with the answers listed for it, one after another and
 * the last again, and anything else 404, as GitHub does; and keeps what it was asked, in order.
 * `waiting` is done once it holds a request it will never answer.
 */
export const fakeGitHub = (answers: Readonly<Record<string, ReadonlyArray<FakeAnswer>>>) => {
  const asked: Array<Asked> = []
  const waiting = Deferred.makeUnsafe<void>()
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = yield* bodyOf(request)
      const question = `${request.method} ${url.pathname}`
      const before = asked.filter((earlier) => `${earlier.method} ${earlier.url.pathname}` === question).length
      asked.push({ method: request.method, url, headers: request.headers, body })
      const listed = answers[question] ?? [notFound]
      const answer = listed[Math.min(before, listed.length - 1)] ?? notFound
      if (answer === "no answer") {
        yield* Deferred.succeed(waiting, undefined)
        return yield* Effect.never
      }
      if (answer === "connection lost") {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "Connection reset by peer" }),
        })
      }
      const text = answer.body === undefined ? null : yield* encodeJson(answer.body).pipe(Effect.orDie)
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, {
          status: answer.status,
          headers: { "content-type": "application/json; charset=utf-8", ...answer.headers },
        }),
      )
    }),
  )
  return { asked, waiting, layer: Layer.succeed(HttpClient.HttpClient, client) }
}
