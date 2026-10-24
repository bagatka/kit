import { Context, Effect, Function, Layer, Option, Predicate, Stream } from "effect"
import { AiError, IdGenerator, LanguageModel } from "effect/ai"

import { completeAnswer, completeAnswerStream, streamedAnswer } from "./answers.ts"
import { failureOf, messageOf } from "./failures.ts"
import { messagesOf, toolsUnsupported } from "./messages.ts"
import type { WorkersAiBinding } from "./workers-ai-binding.ts"
import type { WorkersAiModel } from "./workers-ai-model.ts"

// Effect's provider-neutral `LanguageModel` on Cloudflare Workers AI, through a Worker's AI binding,
// in the shape Effect's own providers have: a layer of a model and its request settings, and
// `withConfigOverride` for a part of a program.

/**
 * Request settings Workers AI's text-generation models take, by its names; a setting left out is
 * the model's default. Without `max_tokens`, most models stop at 256 tokens, which cuts longer
 * answers short. Workers AI checks each value's range.
 */
export class Config extends Context.Service<
  Config,
  {
    readonly max_tokens?: number | undefined
    /** How random answers are, from 0 to 5. */
    readonly temperature?: number | undefined
    readonly top_p?: number | undefined
    readonly top_k?: number | undefined
    readonly seed?: number | undefined
    readonly repetition_penalty?: number | undefined
    readonly frequency_penalty?: number | undefined
    readonly presence_penalty?: number | undefined
  }
>()("@bagatka/ai-cloudflare-binding/cloudflare-binding-language-model/Config") {}

/** Which model to run, through which binding, and its request settings. */
export interface Options {
  /** The Workers AI binding: `env.AI`. */
  readonly binding: WorkersAiBinding
  readonly model: WorkersAiModel
  readonly config?: typeof Config.Service | undefined
}

// The settings `Config` names, and only those: an object with other keys, such as one parsed from
// JSON, can't set the prompt or anything else Workers AI takes.
const settings = [
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "seed",
  "repetition_penalty",
  "frequency_penalty",
  "presence_penalty",
] as const

// The settings a request is made with: the layer's, and over them any override in scope, each
// left out when undefined.
const configOf = (defaults: typeof Config.Service | undefined) =>
  Effect.map(Effect.serviceOption(Config), (override) => {
    const merged = { ...defaults, ...Option.getOrUndefined(override) }
    return Object.fromEntries(
      settings.flatMap((name) => (merged[name] === undefined ? [] : [[name, merged[name]] as const])),
    )
  })

// JSON mode takes the bare JSON Schema (https://developers.cloudflare.com/workers-ai/features/json-mode/),
// not OpenAI's `{ name, schema }`, also for the models that answer as OpenAI does; the object's name
// becomes its title. The schema comes from the transformer `LanguageModel.make` decodes answers with.
const responseFormatOf = (format: LanguageModel.ProviderOptions["responseFormat"]) => {
  switch (format.type) {
    case "text":
      return Effect.succeed({})
    case "json":
      return Effect.try({
        try: () => ({
          response_format: {
            type: "json_schema",
            json_schema: {
              title: format.objectName,
              ...LanguageModel.defaultCodecTransformer(format.schema).jsonSchema,
            },
          },
        }),
        catch: (cause) => new AiError.UnsupportedSchemaError({ description: messageOf(cause) }),
      })
  }
}

// A Worker's `ReadableStream` is async-iterable, of bytes; an answer that came whole is an object.
const isByteStream = (output: unknown): output is AsyncIterable<Uint8Array> =>
  Predicate.hasProperty(output, Symbol.asyncIterator)

/** `LanguageModel` on `options.model`, run through `options.binding`. */
export const make = (options: Options): Effect.Effect<LanguageModel.LanguageModel> => {
  const run = Effect.fn("CloudflareBindingLanguageModel.run")(function* (inputs: Readonly<Record<string, unknown>>) {
    return yield* Effect.tryPromise({
      try: (signal) => options.binding.run(options.model, inputs, { signal }),
      catch: failureOf,
    })
  })

  const inputsOf = Effect.fnUntraced(function* (provider: LanguageModel.ProviderOptions, stream: boolean) {
    if (provider.tools.length > 0) {
      return yield* new AiError.InvalidRequestError({ parameter: "toolkit", description: toolsUnsupported })
    }
    const messages = yield* messagesOf(provider.prompt)
    const format = yield* responseFormatOf(provider.responseFormat)
    const config = yield* configOf(options.config)
    const inputs: Readonly<Record<string, unknown>> = {
      ...config,
      messages,
      ...format,
      ...(stream ? { stream: true } : {}),
    }
    return inputs
  })

  const generateText = Effect.fn("CloudflareBindingLanguageModel.generateText")(
    function* (provider: LanguageModel.ProviderOptions) {
      const inputs = yield* inputsOf(provider, false)
      const output = yield* run(inputs)
      return yield* completeAnswer(output)
    },
    Effect.mapError((reason) =>
      AiError.make({ module: "CloudflareBindingLanguageModel", method: "generateText", reason }),
    ),
  )

  const streamText = (provider: LanguageModel.ProviderOptions) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const inputs = yield* inputsOf(provider, true)
        const output = yield* run(inputs)
        const ids = yield* IdGenerator.IdGenerator
        const id = yield* ids.generateId()
        return isByteStream(output) ? streamedAnswer(output, id) : completeAnswerStream(output, id)
      }),
    ).pipe(
      Stream.mapError((reason) =>
        AiError.make({ module: "CloudflareBindingLanguageModel", method: "streamText", reason }),
      ),
    )

  return LanguageModel.make({ generateText, streamText })
}

/**
 * `LanguageModel` on `options.model`, run through `options.binding`, with `options.config`'s
 * settings, over which `withConfigOverride` sets others for a part of a program.
 *
 * - `generateText` sends the prompt's system, user and assistant messages, their text, and answers
 *   with the model's text, then a finish part with its reason and tokens. A reason the model didn't
 *   state, as Workers AI's own answer shape doesn't, is `unknown`.
 * - `streamText` asks with `stream: true` and gives text deltas as they come, then the finish part;
 *   a stream cut off before its end finishes with `error`.
 * - `generateObject` asks in Workers AI's JSON mode, with the schema's JSON Schema, and
 *   `effect/ai` decodes the answer's text as JSON. Not every model has JSON mode.
 *
 * Fails with `AiError`: `InvalidRequestError` for a request with tools, which aren't supported;
 * `InvalidUserInputError` for a prompt with files or tool calls and results; the binding's
 * failures as their reasons, such as `RateLimitError` for Workers AI out of capacity or
 * `InvalidRequestError` for no such model; `InvalidResponseError`, never retried, for an answer
 * it can't read; `InvalidOutputError` for JSON mode's answer that didn't meet the schema.
 * Each call is one run, never retried; interrupting it aborts the run.
 */
export const layer = (options: Options): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, make(options))

/**
 * `self` with `overrides` over the settings its language model calls are made with, such as a
 * longer `max_tokens` for one draft; outside it, the layer's settings stay as they were.
 */
export const withConfigOverride: {
  (overrides: typeof Config.Service): <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, Exclude<R, Config>>
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service): Effect.Effect<A, E, Exclude<R, Config>>
} = Function.dual(
  2,
  <A, E, R>(self: Effect.Effect<A, E, R>, overrides: typeof Config.Service): Effect.Effect<A, E, Exclude<R, Config>> =>
    Effect.flatMap(Effect.serviceOption(Config), (current) =>
      Effect.provideService(self, Config, { ...Option.getOrUndefined(current), ...overrides }),
    ),
)
