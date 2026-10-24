import { CloudflareClient, CloudflareDecisionModel } from "@effect/ai-cloudflare"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Predicate, Redacted, Schema } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"

import type { WorkersAiBinding } from "../src/index.ts"
import { CloudflareBindingClient } from "../src/index.ts"

// The runtime's `Response` and `TextDecoder`, which tests outside a runtime with its types can't
// name: the parts these tests use.
declare const Response: new (body: string, init: { readonly status: number }) => object
declare const TextDecoder: new () => { readonly decode: (input: Uint8Array) => string }

interface Asked {
  readonly model: string
  readonly inputs: Readonly<Record<string, unknown>>
}

// A fake binding: answers each run with the next answer, or rejects with the next failure, as the
// binding throws, and keeps what it was asked.
const fakeBinding = (answers: Array<{ readonly answer: unknown } | { readonly failure: unknown }>) => {
  const asked: Array<Asked> = []
  const binding: WorkersAiBinding = {
    run: (model, inputs) => {
      asked.push({ model, inputs })
      const next = answers.shift() ?? { failure: { message: "The fake binding has no more answers" } }
      return "answer" in next ? Promise.resolve(next.answer) : Promise.reject(next.failure)
    },
  }
  return { asked, binding }
}

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Json))
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// Cloudflare's REST API as Effect's own client reaches it: each request answered with `status` and
// `body`, and kept, with its path and JSON body.
const fakeRest = (status: number, body: unknown) => {
  const sent: Array<{ readonly path: string; readonly body: unknown }> = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "null"
      sent.push({ path: url.pathname, body: yield* decodeJson(text) })
      const answer = yield* encodeJson(body)
      return HttpClientResponse.fromWeb(request, new Response(answer, { status }))
    }).pipe(Effect.orDie),
  )
  const layer = CloudflareClient.layer({ accountId: "acme", apiKey: Redacted.make("not-a-real-token") }).pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  )
  return { sent, layer }
}

// Effect's Clef decision model, as `@effect/ai-cloudflare` writes it, on a client.
const clefFlash = (client: Layer.Layer<CloudflareClient.CloudflareClient>) =>
  CloudflareDecisionModel.layer({ model: "clef-flash" }).pipe(Layer.provide(client))

const Triage = Decision.make({
  input: Schema.String,
  decisions: {
    urgent: Decision.probability({ instructions: "Does this report need someone now?" }),
    team: Decision.classify({
      instructions: "Which team owns what failed?",
      criteria: { payments: "Checkout and refunds", sync: "Notes moving between devices", auth: null },
    }),
    severity: Decision.rate({
      instructions: "How many people does it stop?",
      criteria: ["nobody", "a few", "many", "everyone"],
    }),
  },
})

const report = "Checkout has been failing for every customer for an hour."
const triage = DecisionModel.decide(Triage, { input: report })

// What Clef answers for those three questions, in its output schema's shape: a probability, a
// choice with every option's probability, and a probability-weighted score of the levels, by index.
const clefAnswer = {
  model: "clef-flash",
  answers: {
    urgent: { type: "noul", noul: 0.9312 },
    team: {
      type: "choice",
      choice: "payments",
      probabilities: { payments: 0.8841, sync: 0.0447, auth: 0.0712 },
      confidence: 0.8841,
    },
    severity: {
      type: "score",
      score: 2.61,
      probabilities: { "0": 0.0105, "1": 0.0602, "2": 0.2381, "3": 0.6912 },
      confidence: 0.6912,
      legend: { "0": "nobody", "1": "a few", "2": "many", "3": "everyone" },
    },
  },
  usage: { input_tokens: 412, output_tokens: 9 },
}

// Every failure Cloudflare documents for Workers AI (developers.cloudflare.com/workers-ai/platform/
// errors/): its code, its HTTP status, and its message.
const documented = [
  [5007, 400, "No such model @cf/cloudflare/clef-flash or task"],
  [5004, 400, "Invalid data type for base64 input: string"],
  [3039, 400, "Finetune is missing required files (model.safetensors and config.json)"],
  [3003, 400, "Request is missing headers or body: body"],
  [5018, 403, "The account is not allowed to access this model"],
  [5016, 403, "User has not agreed to Llama3.2 model terms"],
  [3023, 403, "Service unavailable for account"],
  [3041, 403, "The account is not allowed to access this model"],
  [5035, 403, "This model requires a Workers Paid plan."],
  [5019, 405, "Request trying to use deprecated SDK version"],
  [5005, 405, "The model clef-flash does not support LoRa inference"],
  [3042, 404, "The model name is invalid"],
  [3006, 413, "Request is too large"],
  [3007, 408, "Request timeout"],
  [3008, 408, "Request was aborted"],
  [3036, 429, "You have used up your daily free allocation of 10,000 neurons."],
  [3040, 429, "Capacity temporarily exceeded, please try again."],
] as const

describe("CloudflareBindingClient", () => {
  it.effect("asks the binding exactly what Effect's REST client sends Cloudflare, and decides the same", () =>
    Effect.gen(function* () {
      const rest = fakeRest(200, { success: true, result: clefAnswer })
      const overRest = yield* triage.pipe(Effect.provide(clefFlash(rest.layer)))
      const fake = fakeBinding([{ answer: clefAnswer }])
      const throughBinding = yield* triage.pipe(
        Effect.provide(clefFlash(CloudflareBindingClient.layer({ binding: fake.binding }))),
      )

      assert.strictEqual(rest.sent[0]?.path, "/client/v4/accounts/acme/ai/run/@cf/cloudflare/clef-flash")
      assert.strictEqual(fake.asked[0]?.model, "@cf/cloudflare/clef-flash")
      // As JSON, the form the binding sends it in.
      const inputs = yield* encodeJson(fake.asked[0]?.inputs).pipe(Effect.flatMap(decodeJson), Effect.orDie)
      assert.deepStrictEqual(inputs, rest.sent[0]?.body)
      assert.deepStrictEqual(throughBinding.answers, overRest.answers)
      assert.strictEqual(throughBinding.answers.urgent.probability, 0.9312)
      assert.strictEqual(throughBinding.answers.team.label, "payments")
      assert.strictEqual(throughBinding.answers.severity.probabilities.everyone, 0.6912)
      assert.deepStrictEqual([throughBinding.usage.inputTokens, throughBinding.usage.outputTokens], [412, 9])
    }),
  )

  it.effect("fails as Effect's REST client does for every failure Cloudflare documents", () =>
    Effect.gen(function* () {
      for (const [code, status, message] of documented) {
        const rest = fakeRest(status, { success: false, errors: [{ code, message }] })
        const overRest = yield* triage.pipe(Effect.flip, Effect.provide(clefFlash(rest.layer)))
        const fake = fakeBinding([{ failure: { name: "InferenceUpstreamError", message: `${code}: ${message}` } }])
        const throughBinding = yield* triage.pipe(
          Effect.flip,
          Effect.provide(clefFlash(CloudflareBindingClient.layer({ binding: fake.binding }))),
        )
        const [restReason, bindingReason] = [overRest.reason, throughBinding.reason]
        assert.strictEqual(bindingReason._tag, restReason._tag, `${code}`)
        assert.strictEqual(throughBinding.isRetryable, overRest.isRetryable, `${code}`)
        assert.strictEqual(
          bindingReason._tag === "AuthenticationError" ? bindingReason.kind : undefined,
          restReason._tag === "AuthenticationError" ? restReason.kind : undefined,
          `${code}`,
        )
        assert.deepPropertyVal(bindingReason, "metadata", { workersAi: { code, message: `${code}: ${message}` } })
        assert.strictEqual(throughBinding.module, "CloudflareBindingClient")
        assert.strictEqual(throughBinding.method, "createDecisions")
      }
    }),
  )

  it.effect("fails with InvalidResponseError, not retried, for an answer of another shape", () =>
    Effect.gen(function* () {
      // Clef's answer without what it counted.
      const fake = fakeBinding([{ answer: { model: "clef-flash", answers: clefAnswer.answers } }])
      const failure = yield* triage.pipe(
        Effect.flip,
        Effect.provide(clefFlash(CloudflareBindingClient.layer({ binding: fake.binding }))),
      )
      assert.deepStrictEqual([failure.reason._tag, failure.isRetryable], ["InvalidResponseError", false])
    }),
  )

  it.effect("aborts the run when it is interrupted", () =>
    Effect.gen(function* () {
      const signals: Array<unknown> = []
      const binding: WorkersAiBinding = {
        run: (_model, _inputs, options) => {
          signals.push(options?.signal)
          // A run that never answers.
          return Promise.race([])
        },
      }
      const fiber = yield* Effect.forkChild(
        triage.pipe(Effect.provide(clefFlash(CloudflareBindingClient.layer({ binding })))),
      )
      while (signals.length === 0) {
        yield* Effect.yieldNow
      }
      yield* Fiber.interrupt(fiber)

      const signal = signals[0]
      assert.isTrue(Predicate.hasProperty(signal, "aborted") && signal.aborted === true)
    }),
  )
})
