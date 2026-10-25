import { CloudflareClient, CloudflareSchema } from "@effect/ai-cloudflare"
import { Effect, Layer, Schema } from "effect"
import { AiError } from "effect/ai"
import { HttpClient } from "effect/http"

import { failureOf } from "./failures.ts"
import type { WorkersAiBinding } from "./workers-ai-binding.ts"

// `@effect/ai-cloudflare`'s client of Cloudflare's Clef decisions, through a Worker's AI binding in
// place of Cloudflare's REST API: the binding runs `@cf/cloudflare/<model>` on what Effect's
// `CloudflareDecisionModel` asks, and answers with what REST's `result` holds.

/** Which binding decisions run through. */
export interface Options {
  /** The Workers AI binding: `env.AI`. */
  readonly binding: WorkersAiBinding
}

const decodeAnswer = Schema.decodeUnknownEffect(CloudflareSchema.DecisionsResponse)

// The HTTP client Effect's REST client sends with, which its service offers too. Nothing reaches
// Cloudflare through this one, and nothing in `@effect/ai-cloudflare` uses it; one that did is a
// bug, and dies saying why.
const noHttp = HttpClient.make((request) =>
  Effect.die(`${request.method} ${request.url}: this CloudflareClient runs through the AI binding and sends no HTTP`),
)

/**
 * `@effect/ai-cloudflare`'s `CloudflareClient` on a Worker's AI binding, `env.AI`, with no account
 * ID or API token: provide it to Effect's `CloudflareDecisionModel.layer` and its decisions run
 * through the binding. Each decision is one run, never retried; interrupting it aborts the run.
 * Fails with `AiError`: the binding's failures as their reasons, as for text, such as
 * `RateLimitError` for Workers AI out of capacity; and `InvalidResponseError`, never retried, for an
 * answer of another shape.
 */
export const layer = (options: Options): Layer.Layer<CloudflareClient.CloudflareClient> =>
  Layer.succeed(
    CloudflareClient.CloudflareClient,
    CloudflareClient.CloudflareClient.of({
      client: noHttp,
      createDecisions: Effect.fn("CloudflareBindingClient.createDecisions", { kind: "client" })(
        function* (request) {
          const output = yield* Effect.tryPromise({
            try: (signal) => options.binding.run(`@cf/cloudflare/${request.model}`, request, { signal }),
            catch: failureOf,
          })
          return yield* decodeAnswer(output).pipe(
            Effect.mapError((error) => AiError.InvalidResponseError.fromSchemaError(error)),
          )
        },
        Effect.mapError((reason) =>
          AiError.make({ module: "CloudflareBindingClient", method: "createDecisions", reason }),
        ),
      ),
    }),
  )
