# @bagatka/ai-cloudflare-binding

Effect AI from a Cloudflare Worker, through its AI binding (`env.AI`), with no account ID or API
token: Effect's `LanguageModel` on Workers AI's text-generation models, for text, streamed text and
structured output; and Cloudflare's Clef decisions, by running `@effect/ai-cloudflare`'s
`CloudflareDecisionModel` through the binding.

It is for a Worker only. Outside one, or for Clef over Cloudflare's REST API with a token, use
Effect's own [`@effect/ai-cloudflare`](https://www.npmjs.com/package/@effect/ai-cloudflare). When
Effect's own packages run through the binding, this package moves to them and retires.

## Install

```sh
npm install @bagatka/ai-cloudflare-binding @effect/ai-cloudflare effect
```

Its peer dependencies are `effect` and `@effect/ai-cloudflare`, at the minor version it is built
with: your program uses those copies too. It runs in a Cloudflare Worker, on the Worker's AI
binding, which the host passes.

## Use it

```ts
import { CloudflareBindingClient, CloudflareBindingLanguageModel, WorkersAiModel } from "@bagatka/ai-cloudflare-binding"
import { CloudflareDecisionModel } from "@effect/ai-cloudflare"
import { Config, Effect, Layer, Schema } from "effect"
import { Decision, DecisionModel, LanguageModel } from "effect/ai"

// In a Worker's host, with its AI binding (`"ai": { "binding": "AI" }` in wrangler.jsonc). The model
// comes from configuration, decoded, so an ID of the wrong shape fails at startup.
const LanguageModelLive = Layer.unwrap(
  Effect.map(Config.schema(WorkersAiModel, "AI_MODEL"), (model) =>
    CloudflareBindingLanguageModel.layer({ binding: env.AI, model, config: { max_tokens: 1024 } }),
  ),
)
// Effect's own Clef decisions, through the same binding.
const DecisionModelLive = CloudflareDecisionModel.layer({ model: "clef-flash" }).pipe(
  Layer.provide(CloudflareBindingClient.layer({ binding: env.AI })),
)

// Anywhere: text from whichever model the host chose.
const draft = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: [
      { role: "system", content: "You write release notes in plain sentences." },
      { role: "user", content: "Summarize: fixed sync on iOS 18; exports keep their dates." },
    ],
  })
  return response.text // "Sync works again on iOS 18, and exports keep their dates."
  // response.finishReason: "stop", "length", …, or "unknown" when the model didn't say
  // response.usage.outputTokens.total: 14, or undefined when Workers AI didn't count
})

// Other settings for part of a program, as with Effect's own providers.
const long = draft.pipe(CloudflareBindingLanguageModel.withConfigOverride({ max_tokens: 4096 }))

// And decisions: a probability, a choice, a rating.
const Triage = Decision.make({
  input: Schema.String,
  decisions: { urgent: Decision.probability({ instructions: "Does this report need someone now?" }) },
})
const triaged = DecisionModel.decide(Triage, { input: "Checkout fails for everyone." })
// (yield* triaged).answers.urgent.probability: 0.93
```

`streamText` gives the text as `text-delta` parts while the model writes, then a `finish` part.
`generateObject({ prompt, schema, objectName })` asks in Workers AI's JSON mode and decodes the
answer with the schema. Decisions are Effect's `DecisionModel`, as `@effect/ai-cloudflare`
documents it, images included.

Every failure is an `AiError` whose `reason` says what happened. Workers AI out of capacity is a
`RateLimitError`, which `isRetryable`: ask again later. A model Workers AI doesn't have is an
`InvalidRequestError`, which asking again won't change:

```ts
const drafted = draft.pipe(
  Effect.catchReason("AiError", "RateLimitError", () => Effect.succeed("The draft is waiting for Workers AI.")),
)
```

## Contract

`src/index.ts`. A host builds `CloudflareBindingLanguageModel.layer` once, with the binding, a model
and its settings, and `CloudflareBindingClient.layer` once, with the binding, under Effect's
`CloudflareDecisionModel.layer`; everything else uses `effect/ai`'s `LanguageModel` and
`DecisionModel`, so another provider's layer can replace these without changing callers. The
language model has the shape of Effect's own providers, such as `OpenAiLanguageModel`:
`layer({ model, config })`, `Config`, and `withConfigOverride`.

## Does not own

- **Clef's decisions themselves.** What to ask Clef and how its answers become decisions is
  `@effect/ai-cloudflare`'s; this package only carries them through the binding.
- **Tool calls.** Workers AI offers them on some models; this package refuses a request with a
  toolkit, or a prompt with tool calls or results, until a product needs them.
- **Files and images** in a text prompt, which Workers AI's text models don't take.
- **Asking again.** Nothing is retried here; `AiError.isRetryable` says whether asking again may
  work.

## Depends on

`effect`, for `effect/ai`; `@effect/ai-cloudflare`, whose `CloudflareClient` it provides; and a
Workers AI binding the host passes, `env.AI`.

## Settings

The binding; for text, the model, a `WorkersAiModel` such as
`@cf/meta/llama-4-scout-17b-16e-instruct`, which differs between deployments, and `config`, Workers
AI's own request settings by their names (`max_tokens`, `temperature`, `top_p`, `top_k`, `seed`, and
the three penalties), each the model's default when left out. Only those are sent, whatever else a
settings object holds, such as one parsed from JSON, so no setting can replace the prompt or ask for
what this package refuses. Without `max_tokens`, most models stop at 256 tokens, which cuts longer
answers short. For decisions, the Clef model is `CloudflareDecisionModel.layer`'s, `clef` or
`clef-flash`.

## Decisions and constraints

- **Trusts its caller and the binding,** Cloudflare's own runtime. **Doesn't trust what a model
  writes,** which a prompt can steer: `generateObject` decodes it with the caller's schema, an
  answer in a shape Workers AI doesn't document is `InvalidResponseError`, and what the text says is
  the caller's to judge.
- **The binding is structural.** `WorkersAiBinding` is the one method used, `run`, so the package
  needs no Cloudflare types and tests pass a fake. `bun run check` proves that Cloudflare's `Ai`
  binding type fits it.
- **What a prompt becomes.** System, user and assistant messages become Workers AI's `messages`,
  each with its text parts joined as they are, as the models' chat templates join them. An
  assistant's reasoning from an earlier answer is left out. A file, a tool call or result, or a tool
  message fails with `InvalidUserInputError`; a request with a toolkit fails with
  `InvalidRequestError`.
- **Settings come from the layer and `withConfigOverride`.** `effect/ai` 4.0.6 passes a provider no
  sampling settings, so they are this package's `Config`, as in Effect's own providers: the layer's
  `config`, with any override in scope over it. Ignored from what `effect/ai` passes: the tool
  choice, as there are no tools; the incremental prompt and previous response ID, as Workers AI
  keeps no conversation, so the whole prompt is sent each time; and messages' and parts' provider
  options.
- **Two answer shapes.** Workers AI's own, `{ response, usage }` (Llama, Mistral, DeepSeek and
  most models), and OpenAI's chat completion, `{ choices, usage }` (Kimi, Qwen 3, gpt-oss), as the
  models' API schemas on developers.cloudflare.com/workers-ai/models describe them. Workers AI's own
  shape states no finish reason, so it is `unknown`; tokens it didn't count are `undefined`, never
  zero. A model's `reasoning_content` isn't passed on. An answer in neither shape, or a streamed
  event it can't read, fails with `InvalidResponseError`, which isn't retried, as in Effect's own
  providers.
- **Streaming.** `streamText` asks with `stream: true` and reads the server-sent events as they
  come: each `data:` line is a JSON chunk of either shape, until `data: [DONE]`. A stream that ends
  before `[DONE]` with no reason stated finishes with `error`, as cut off. A model that answers a
  stream request whole, as some do, gives its whole answer as one delta. In workerd a
  `ReadableStream` is async-iterable, of bytes, and ending the iteration cancels it (checked in
  workerd 1.20261019.1), so an interrupted `streamText` stops reading Workers AI.
- **Structured output.** `effect/ai`'s `generateObject` passes a provider the JSON response format
  and decodes the answer's text as JSON with the schema; it doesn't describe the schema in the
  prompt. So this package asks in Workers AI's JSON mode, `response_format: { type: "json_schema",
  json_schema }` with the bare JSON Schema and the object's name as its `title`, as Cloudflare's own
  AI SDK provider does for every `@cf/` model; JSON mode's object `response` is read back as JSON
  text. Cloudflare documents JSON mode for a list of models and doesn't guarantee the schema is met:
  "JSON Mode couldn't be met" fails with `InvalidOutputError`, and a model that answers prose fails
  in `effect/ai` with `StructuredOutputError`. JSON mode doesn't stream; `generateObject` doesn't.
- **Failures, as Effect's own Cloudflare client has them.** The binding throws errors whose message
  carries Workers AI's code, and no HTTP status. Each code Cloudflare documents
  (developers.cloudflare.com/workers-ai/platform/errors) becomes the reason Effect's
  `@effect/ai-cloudflare` gives its documented HTTP status over REST, so moving between the binding
  and REST changes no failure: 400 (no such model, invalid data, an incomplete request) is
  `InvalidRequestError`, as is 404 (an invalid model name); 403 (the account may not use the
  model) is `AuthenticationError` of `InsufficientPermissions`; 429 (out of capacity, or the free
  plan's daily neurons used up) is `RateLimitError`; 405, 408 and 413 (a deprecated SDK, LoRA
  unsupported, a timeout, an abort, too large) are `UnknownError`. A code Cloudflare doesn't
  document is `UnknownError` with the binding's message. Each reason's `metadata.workersAi` keeps
  the code and message.
- **Decisions through the binding.** `CloudflareBindingClient` is `@effect/ai-cloudflare`'s
  `CloudflareClient`: it runs `@cf/cloudflare/<model>` on the request Effect's
  `CloudflareDecisionModel` writes, as Cloudflare's Clef documentation shows a Worker doing, and
  decodes the answer with Effect's own `CloudflareSchema.DecisionsResponse`. Its tests run the same
  decisions through Effect's REST client too: the binding is asked exactly what REST is sent, and
  each documented failure is the same reason. An answer of another shape is `InvalidResponseError`. The
  client's HTTP client, which Effect's decision model doesn't use, sends nothing: it dies, saying
  why. Not checked against a live Worker here: the fake binding answers as Clef's documentation
  writes.
- **One run per call.** Interrupting a call aborts the binding's run through its signal.
- **`effect/ai` and `@effect/ai-cloudflare` are unstable.** Both are allowed by name in
  `tsconfig.base.json` and pinned with `effect`; an upgrade reads their changelogs for
  `LanguageModel.make`, the response parts, and `CloudflareClient`.
