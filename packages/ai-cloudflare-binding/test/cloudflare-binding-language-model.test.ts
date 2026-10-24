import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Predicate, Result, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/ai"
import type { Response } from "effect/ai"

import type { WorkersAiBinding } from "../src/index.ts"
import { CloudflareBindingLanguageModel, WorkersAiModel } from "../src/index.ts"

// The runtime's `ReadableStream` and `TextEncoder`, which tests outside a runtime with their types
// can't name: the parts these tests use. A Worker's AI binding streams a `ReadableStream` of bytes.
declare const ReadableStream: new (source: {
  readonly start: (controller: { readonly enqueue: (chunk: Uint8Array) => void; readonly close: () => void }) => void
}) => AsyncIterable<Uint8Array>
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array }

const model = WorkersAiModel.make("@cf/meta/llama-4-scout-17b-16e-instruct")

interface Asked {
  readonly model: string
  readonly inputs: Readonly<Record<string, unknown>>
}

// A fake binding: answers each run with the next answer, or rejects with the next failure, as the
// binding throws, and keeps what it was asked.
const fakeBinding = (answers: Array<{ readonly answer: unknown } | { readonly failure: unknown }>) => {
  const asked: Array<Asked> = []
  const binding: WorkersAiBinding = {
    run: (askedModel, inputs) => {
      asked.push({ model: askedModel, inputs })
      const next = answers.shift() ?? { failure: { message: "The fake binding has no more answers" } }
      return "answer" in next ? Promise.resolve(next.answer) : Promise.reject(next.failure)
    },
  }
  return { asked, binding }
}

// Server-sent events as the binding streams them: bytes, in chunks that needn't end with an event,
// closed after them unless `leftOpen`.
const eventStream = (chunks: ReadonlyArray<string>, leftOpen = false) => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      if (!leftOpen) {
        controller.close()
      }
    },
  })
}

const withWorkersAi = <A, E>(
  fake: ReturnType<typeof fakeBinding>,
  program: Effect.Effect<A, E, LanguageModel.LanguageModel>,
  config?: typeof CloudflareBindingLanguageModel.Config.Service,
) => program.pipe(Effect.provide(CloudflareBindingLanguageModel.layer({ binding: fake.binding, model, config })))

const deltasOf = (parts: ReadonlyArray<Response.StreamPart<{}>>) =>
  parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []))

const finishOf = (parts: ReadonlyArray<Response.StreamPart<{}>>) =>
  parts.flatMap((part) => (part.type === "finish" ? [part] : []))[0]

describe("CloudflareBindingLanguageModel", () => {
  it.effect("sends the prompt's messages as Workers AI's, with the layer's settings", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([
        {
          answer: {
            response: "Sync works again on iOS 18.",
            usage: { prompt_tokens: 48, completion_tokens: 9, total_tokens: 57 },
          },
        },
      ])
      const response = yield* withWorkersAi(
        fake,
        LanguageModel.generateText({
          prompt: [
            { role: "system", content: "You write release notes in one sentence." },
            { role: "user", content: "What changed in 2.4.0?" },
            // An earlier answer, with the model's reasoning, which isn't sent back.
            {
              role: "assistant",
              content: [
                { type: "reasoning", text: "They didn't say which component." },
                { type: "text", text: "Which component?" },
              ],
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Notes for iOS. " },
                { type: "text", text: "Fixed: sync on iOS 18." },
              ],
            },
          ],
        }),
        { max_tokens: 512, temperature: 0.2, seed: undefined },
      )

      assert.deepStrictEqual(fake.asked, [
        {
          model: "@cf/meta/llama-4-scout-17b-16e-instruct",
          inputs: {
            messages: [
              { role: "system", content: "You write release notes in one sentence." },
              { role: "user", content: "What changed in 2.4.0?" },
              { role: "assistant", content: "Which component?" },
              { role: "user", content: "Notes for iOS. Fixed: sync on iOS 18." },
            ],
            max_tokens: 512,
            temperature: 0.2,
          },
        },
      ])
      assert.strictEqual(response.text, "Sync works again on iOS 18.")
      // Workers AI's own answer states no finish reason.
      assert.strictEqual(response.finishReason, "unknown")
      assert.strictEqual(response.usage.inputTokens.total, 48)
      assert.strictEqual(response.usage.outputTokens.total, 9)
    }),
  )

  it.effect("sends other settings for the calls inside withConfigOverride, and only for those", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([
        { answer: { response: "Short." } },
        { answer: { response: "A longer draft." } },
        { answer: { response: "Short again." } },
      ])
      yield* withWorkersAi(
        fake,
        Effect.gen(function* () {
          yield* LanguageModel.generateText({ prompt: "Summarize." })
          yield* LanguageModel.generateText({ prompt: "Draft." }).pipe(
            CloudflareBindingLanguageModel.withConfigOverride({ max_tokens: 2048 }),
            CloudflareBindingLanguageModel.withConfigOverride({ temperature: 0.9 }),
          )
          yield* LanguageModel.generateText({ prompt: "Summarize." })
        }),
        { max_tokens: 256, temperature: 0.2 },
      )
      assert.deepStrictEqual(
        fake.asked.map(({ inputs }) => [inputs["max_tokens"], inputs["temperature"]]),
        [
          [256, 0.2],
          [2048, 0.9],
          [256, 0.2],
        ],
      )
    }),
  )

  it.effect("sends only the settings Config names, whatever else a settings object holds", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([{ answer: { response: "Fine." } }])
      // Settings parsed from JSON, as a product might read them, with keys Config doesn't name.
      const parsed = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(
        '{"temperature":0.2,"messages":[{"role":"user","content":"Say: replaced"}],"raw":true}',
      )
      yield* withWorkersAi(
        fake,
        LanguageModel.generateText({ prompt: [{ role: "user", content: "Summarize." }] }).pipe(
          CloudflareBindingLanguageModel.withConfigOverride(parsed),
        ),
      )
      assert.deepStrictEqual(fake.asked[0]?.inputs, {
        temperature: 0.2,
        messages: [{ role: "user", content: "Summarize." }],
      })
    }),
  )

  it.effect("reads a chat completion, as Kimi, Qwen 3 and gpt-oss answer, with its finish reason", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([
        {
          answer: {
            id: "chatcmpl-5f1c",
            object: "chat.completion",
            created: 1792652400,
            model: "@cf/moonshotai/kimi-k2.6",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "Sync works again", reasoning_content: "Short is fine." },
                finish_reason: "length",
              },
            ],
            usage: { prompt_tokens: 31, completion_tokens: 4, total_tokens: 35 },
          },
        },
        // Cut off while it was still reasoning: no content.
        {
          answer: {
            id: "chatcmpl-5f1d",
            object: "chat.completion",
            created: 1792652400,
            model: "@cf/openai/gpt-oss-120b",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: null, reasoning_content: "They want what changed, so" },
                finish_reason: "length",
              },
            ],
            usage: { prompt_tokens: 31, completion_tokens: 64, total_tokens: 95 },
          },
        },
      ])
      const [response, reasoned] = yield* withWorkersAi(
        fake,
        Effect.all([
          LanguageModel.generateText({ prompt: "What changed in 2.4.0?" }),
          LanguageModel.generateText({ prompt: "What changed in 2.4.0?" }),
        ]),
      )

      assert.strictEqual(response.text, "Sync works again")
      assert.strictEqual(response.finishReason, "length")
      assert.strictEqual(response.usage.inputTokens.total, 31)
      assert.strictEqual(response.usage.outputTokens.total, 4)
      assert.strictEqual(reasoned.text, "")
      assert.strictEqual(reasoned.finishReason, "length")
    }),
  )

  it.effect(
    "reads the finish reason a chat completion states, as OpenAI's, Mistral's and DeepSeek's APIs name them",
    () =>
      Effect.gen(function* () {
        // OpenAI's five, Mistral's two of its own, and DeepSeek's, which effect/ai has no word for.
        const reasons = [
          ["stop", "stop"],
          ["length", "length"],
          ["content_filter", "content-filter"],
          ["tool_calls", "tool-calls"],
          ["function_call", "tool-calls"],
          ["model_length", "length"],
          ["error", "error"],
          ["insufficient_system_resource", "other"],
        ] as const
        const fake = fakeBinding(
          reasons.map(([stated]) => ({
            answer: {
              choices: [{ index: 0, message: { role: "assistant", content: "Notes" }, finish_reason: stated }],
            },
          })),
        )
        const responses = yield* withWorkersAi(
          fake,
          Effect.forEach(reasons, () => LanguageModel.generateText({ prompt: "Ready?" })),
        )

        assert.deepStrictEqual(
          responses.map((response) => response.finishReason),
          reasons.map(([, read]) => read),
        )
      }),
  )

  it.effect("reads an answer that is its text alone, as some models' schemas type it", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([{ answer: "Sync works again on iOS 18." }])
      const response = yield* withWorkersAi(fake, LanguageModel.generateText({ prompt: "What changed in 2.4.0?" }))

      assert.strictEqual(response.text, "Sync works again on iOS 18.")
      assert.strictEqual(response.finishReason, "unknown")
      assert.strictEqual(response.usage.outputTokens.total, undefined)
    }),
  )

  it.effect("asks for structured output in JSON mode, and decodes the object Workers AI answers", () =>
    Effect.gen(function* () {
      const Summary = Schema.Struct({ headline: Schema.String, highlights: Schema.Array(Schema.String) })
      const fake = fakeBinding([
        { answer: { response: { headline: "Sync is back", highlights: ["Sync works on iOS 18"] } } },
      ])
      const response = yield* withWorkersAi(
        fake,
        LanguageModel.generateObject({ prompt: "Summarize 2.4.0.", schema: Summary, objectName: "summary" }),
      )

      assert.deepStrictEqual(response.value, { headline: "Sync is back", highlights: ["Sync works on iOS 18"] })
      assert.deepStrictEqual(fake.asked[0]?.inputs["response_format"], {
        type: "json_schema",
        json_schema: {
          title: "summary",
          type: "object",
          properties: {
            headline: { type: "string" },
            highlights: { type: "array", items: { type: "string" } },
          },
          required: ["headline", "highlights"],
          additionalProperties: true,
        },
      })
    }),
  )

  it.effect("streams Workers AI's own events as text deltas, then the finish with its tokens, until [DONE]", () =>
    Effect.gen(function* () {
      // What follows [DONE] isn't read, readable or not, and the stream isn't waited on to close.
      const fake = fakeBinding([
        {
          answer: eventStream(
            [
              'data: {"response":"Sync ","p":"abcdef"}\n\n',
              'data: {"response":"works"}\n\ndata: {"resp',
              'onse":" again."}\n\n',
              'data: {"response":"","usage":{"prompt_tokens":31,"completion_tokens":4,"total_tokens":35}}\n\n',
              "data: [DONE]\n\n",
              'data: {"response":" Not read."}\n\ndata: {not an event}\n\n',
            ],
            true,
          ),
        },
      ])
      const parts = yield* withWorkersAi(
        fake,
        LanguageModel.streamText({ prompt: "What changed in 2.4.0?" }).pipe(Stream.runCollect),
      )

      assert.strictEqual(fake.asked[0]?.inputs["stream"], true)
      assert.deepStrictEqual(deltasOf(parts), ["Sync ", "works", " again."])
      assert.deepStrictEqual(
        parts.map((part) => part.type),
        ["text-start", "text-delta", "text-delta", "text-delta", "text-end", "finish"],
      )
      const finish = finishOf(parts)
      assert.strictEqual(finish?.reason, "unknown")
      assert.strictEqual(finish?.usage.inputTokens.total, 31)
      assert.strictEqual(finish?.usage.outputTokens.total, 4)
    }),
  )

  it.effect("streams chat completion chunks, with the reason the model stated", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([
        {
          answer: eventStream([
            'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Notes"}}]}\r\n\r\n',
            'data: {"choices":[{"index":0,"delta":{"content":" ready"}}]}\r\n\r\n',
            'data: {"choices":[{"index":0,"finish_reason":"stop"}]}\r\n\r\n',
            'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":2,"total_tokens":14}}\r\n\r\n',
            "data: [DONE]\r\n\r\n",
          ]),
        },
      ])
      const parts = yield* withWorkersAi(fake, LanguageModel.streamText({ prompt: "Ready?" }).pipe(Stream.runCollect))

      assert.deepStrictEqual(deltasOf(parts), ["Notes", " ready"])
      const finish = finishOf(parts)
      assert.strictEqual(finish?.reason, "stop")
      assert.strictEqual(finish?.usage.outputTokens.total, 2)
    }),
  )

  it.effect("finishes a stream cut off before its end with error, unless the model stated its reason", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([
        { answer: eventStream(['data: {"response":"Sync wor"}\n\n']) },
        // A chat completion's chunks state `null` until the last.
        {
          answer: eventStream(['data: {"choices":[{"index":0,"delta":{"content":"Notes"},"finish_reason":null}]}\n\n']),
        },
        // Its reason stated, then cut off before [DONE].
        {
          answer: eventStream([
            'data: {"choices":[{"index":0,"delta":{"content":"Notes"},"finish_reason":"stop"}]}\n\n',
          ]),
        },
        // Cut off before its first event.
        { answer: eventStream([]) },
      ])
      const streams = yield* withWorkersAi(
        fake,
        Effect.forEach([1, 2, 3, 4], () =>
          LanguageModel.streamText({ prompt: "What changed?" }).pipe(Stream.runCollect),
        ),
      )

      assert.deepStrictEqual(streams.map(deltasOf), [["Sync wor"], ["Notes"], ["Notes"], []])
      assert.deepStrictEqual(
        streams.map((parts) => finishOf(parts)?.reason),
        ["error", "error", "stop", "error"],
      )
    }),
  )

  it.effect("streams an answer Workers AI gave whole as one delta, its uncounted tokens unknown", () =>
    Effect.gen(function* () {
      const fake = fakeBinding([{ answer: { response: "Sync works again." } }, { answer: { response: null } }])
      const streamed = LanguageModel.streamText({ prompt: "What changed?" }).pipe(Stream.runCollect)
      const [parts, empty] = yield* withWorkersAi(fake, Effect.all([streamed, streamed]))

      assert.deepStrictEqual(deltasOf(parts), ["Sync works again."])
      const finish = finishOf(parts)
      assert.strictEqual(finish?.usage.inputTokens.total, undefined)
      assert.strictEqual(finish?.usage.outputTokens.total, undefined)
      // An answer with no text has no delta at all.
      assert.deepStrictEqual(
        empty.map((part) => part.type),
        ["text-start", "text-end", "finish"],
      )
    }),
  )

  it.effect("fails with the AiError reason that matches what the binding threw, keeping its code and message", () =>
    Effect.gen(function* () {
      // Messages as the binding writes them, `<code>: <description>`, with Workers AI's codes and
      // descriptions (developers.cloudflare.com/workers-ai/platform/errors/), and what each becomes.
      const thrown = [
        ["InferenceUpstreamError: 3040: Capacity temporarily exceeded, please try again.", 3040, "RateLimitError", {}],
        ["5007: No such model @cf/meta/llama-9 or task", 5007, "InvalidRequestError", {}],
        ["5019: Request trying to use deprecated SDK version", 5019, "UnknownError", {}],
        [
          "5035: This model requires a Workers Paid plan.",
          5035,
          "AuthenticationError",
          { kind: "InsufficientPermissions" },
        ],
        ["3036: You have used up your daily free allocation of 10,000 neurons.", 3036, "RateLimitError", {}],
        ["3008: Request was aborted", 3008, "UnknownError", {}],
      ] as const
      // And failures without a code Workers AI documents: JSON mode's, one with a code the Cloudflare
      // API writes, and one with none.
      const uncoded = [
        ["JSON Mode couldn't be met", "InvalidOutputError"],
        ["7003: Could not route to /accounts/acme/ai/run, perhaps your object identifier is invalid?", "UnknownError"],
        ["Something unexpected happened", "UnknownError"],
      ] as const
      const fake = fakeBinding(
        [...thrown, ...uncoded].map(([message]) => ({ failure: { name: "InferenceUpstreamError", message } })),
      )
      const failures = yield* withWorkersAi(
        fake,
        Effect.forEach([...thrown, ...uncoded], () => LanguageModel.generateText({ prompt: "Hi" }).pipe(Effect.flip)),
      )

      for (const [index, [message, code, tag, fields]] of thrown.entries()) {
        const reason = failures[index]?.reason
        assert.strictEqual(reason?._tag, tag, message)
        assert.deepInclude(reason, fields, message)
        assert.deepPropertyVal(reason, "metadata", { workersAi: { code, message } }, message)
      }
      for (const [index, [message, tag]] of uncoded.entries()) {
        const reason = failures[thrown.length + index]?.reason
        assert.strictEqual(reason?._tag, tag, message)
        assert.deepPropertyVal(reason, "metadata", { workersAi: { message } }, message)
      }
      assert.strictEqual(failures[0]?.module, "CloudflareBindingLanguageModel")
      assert.strictEqual(failures[0]?.method, "generateText")
      assert.isTrue(failures[0]?.isRetryable)
      assert.isFalse(failures[1]?.isRetryable)
      const unknown = failures.at(-1)?.reason
      assert.strictEqual(
        unknown?._tag === "UnknownError" ? unknown.description : undefined,
        "Something unexpected happened",
      )

      // A failure that isn't an error with a message, which the binding doesn't throw, still says so.
      const silent = yield* withWorkersAi(
        fakeBinding([{ failure: "busy" }]),
        LanguageModel.generateText({ prompt: "Hi" }).pipe(Effect.flip),
      )
      assert.strictEqual(
        silent.reason._tag === "UnknownError" ? silent.reason.description : undefined,
        "Workers AI failed without saying why",
      )
    }),
  )

  it.effect("fails with InvalidResponseError, not retried, for an answer or a streamed event it can't read", () =>
    Effect.gen(function* () {
      const whole = [
        // An embedding model's answer: neither shape.
        { shape: [1, 3], data: [[0.12, -0.03, 0.4]] },
        // Content as a list of parts, and tokens counted in text: neither shape has them.
        { choices: [{ index: 0, message: { role: "assistant", content: [{ type: "text", text: "Sync works" }] } }] },
        { response: "Sync works again.", usage: { prompt_tokens: "31", completion_tokens: "4" } },
      ]
      const streamed = [
        'data: {"response":{"text":"Sync "}}\n\n',
        'data: {"choices":[{"index":0,"delta":{"content":[{"type":"text","text":"Sync"}]}}]}\n\n',
        "data: Sync works\n\n",
      ]
      const fake = fakeBinding([
        ...whole.map((answer) => ({ answer })),
        ...streamed.map((event) => ({ answer: eventStream([event, "data: [DONE]\n\n"]) })),
      ])
      const failures = yield* withWorkersAi(
        fake,
        Effect.gen(function* () {
          const generated = yield* Effect.forEach(whole, () =>
            LanguageModel.generateText({ prompt: "What changed?" }).pipe(Effect.flip),
          )
          const streams = yield* Effect.forEach(streamed, () =>
            LanguageModel.streamText({ prompt: "What changed?" }).pipe(Stream.runCollect, Effect.flip),
          )
          return [...generated, ...streams]
        }),
      )

      assert.deepStrictEqual(
        failures.map((failure) => [failure.module, failure.method, failure.reason._tag, failure.isRetryable]),
        [
          ["CloudflareBindingLanguageModel", "generateText", "InvalidResponseError", false],
          ["CloudflareBindingLanguageModel", "generateText", "InvalidResponseError", false],
          ["CloudflareBindingLanguageModel", "generateText", "InvalidResponseError", false],
          ["CloudflareBindingLanguageModel", "streamText", "InvalidResponseError", false],
          ["CloudflareBindingLanguageModel", "streamText", "InvalidResponseError", false],
          ["CloudflareBindingLanguageModel", "streamText", "InvalidResponseError", false],
        ],
      )
    }),
  )

  it.effect("refuses tools, tool calls in the prompt, and files, without running the model", () =>
    Effect.gen(function* () {
      const GetWeather = Tool.make("GetWeather", {
        parameters: Schema.Struct({ city: Schema.String }),
        success: Schema.String,
      })
      const Weather = Toolkit.make(GetWeather)
      const fake = fakeBinding([])

      const withTools = yield* withWorkersAi(
        fake,
        LanguageModel.generateText({ prompt: "Weather in Lisbon?", toolkit: Weather }).pipe(
          Effect.flip,
          Effect.provide(Weather.toLayer({ GetWeather: () => Effect.succeed("Sunny") })),
        ),
      )
      const reason = withTools.reason
      assert.strictEqual(reason._tag, "InvalidRequestError")
      assert.strictEqual(reason._tag === "InvalidRequestError" ? reason.parameter : undefined, "toolkit")
      assert.match(reason.message, /tool calls aren't supported/)

      // A tool's message, or an assistant's with a tool call, a tool's result, or an approval asked for.
      const result = {
        type: "tool-result",
        id: "call-1",
        name: "GetWeather",
        isFailure: false,
        result: "Sunny",
      } as const
      for (const message of [
        { role: "tool", content: [result] },
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "call-1", name: "GetWeather", params: { city: "Lisbon" } }],
        },
        { role: "assistant", content: [result] },
        {
          role: "assistant",
          content: [{ type: "tool-approval-request", approvalId: "approval-1", toolCallId: "call-1" }],
        },
      ] as const) {
        const toolCallsInPrompt = yield* withWorkersAi(
          fake,
          LanguageModel.generateText({ prompt: [{ role: "user", content: "Weather in Lisbon?" }, message] }).pipe(
            Effect.flip,
          ),
        )
        assert.strictEqual(toolCallsInPrompt.reason._tag, "InvalidUserInputError", message.content[0].type)
      }

      const file = yield* withWorkersAi(
        fake,
        LanguageModel.generateText({
          prompt: [
            {
              role: "user",
              content: [{ type: "file", mediaType: "image/png", data: "iVBORw0KGgo=" }],
            },
          ],
        }).pipe(Effect.flip),
      )
      assert.strictEqual(file.reason._tag, "InvalidUserInputError")
      assert.match(file.reason.message, /image\/png/)

      assert.deepStrictEqual(fake.asked, [])
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
        LanguageModel.generateText({ prompt: "Hi" }).pipe(
          Effect.provide(CloudflareBindingLanguageModel.layer({ binding, model })),
        ),
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

describe("WorkersAiModel", () => {
  it.effect("is a catalog ID: @cf/ or @hf/, an author and a name", () =>
    Effect.gen(function* () {
      const scout = yield* Schema.decodeEffect(WorkersAiModel)("@cf/meta/llama-4-scout-17b-16e-instruct").pipe(
        Effect.result,
      )
      assert.isTrue(Result.isSuccess(scout))

      // The name alone, the API's URL for it, and an ID read from a file with its newline.
      for (const wrong of [
        "llama-4-scout-17b-16e-instruct",
        "https://api.cloudflare.com/client/v4/accounts/acme/ai/run/@cf/meta/llama-4-scout-17b-16e-instruct",
        "@cf/meta/llama-4-scout-17b-16e-instruct\n",
      ]) {
        const refused = yield* Schema.decodeEffect(WorkersAiModel)(wrong).pipe(Effect.result)
        assert.isTrue(Result.isFailure(refused), wrong)
      }
    }),
  )
})
