import { Effect, Schema, Stream } from "effect"
import type { Response } from "effect/ai"
import { AiError } from "effect/ai"

import { failureOf } from "./failures.ts"

// What Workers AI answers, in the two shapes its text-generation models use (their pages'
// "API Schemas", https://developers.cloudflare.com/workers-ai/models/):
// - its own, `{ response, usage }`: Llama, Mistral, DeepSeek and most others. In JSON mode,
//   `response` is the object itself (https://developers.cloudflare.com/workers-ai/features/json-mode/).
// - OpenAI's chat completion, `{ choices: [{ message, finish_reason }], usage }`: Kimi, Qwen 3 and
//   gpt-oss.
// Streamed with `stream: true`, each server-sent event's `data` is a JSON chunk of either shape,
// `{ response }` or `{ choices: [{ delta }] }`, the last ones with `usage`, then `[DONE]`.

const TokenUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Int),
  completion_tokens: Schema.optional(Schema.Int),
})
type TokenUsage = typeof TokenUsage.Type

const StatedReason = Schema.optional(Schema.NullOr(Schema.String))

const OwnAnswer = Schema.Struct({
  response: Schema.Json,
  usage: Schema.optional(Schema.NullOr(TokenUsage)),
  finish_reason: StatedReason,
})

const ChatCompletion = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }),
      finish_reason: StatedReason,
    }),
  ),
  usage: Schema.optional(Schema.NullOr(TokenUsage)),
})

// Some models' outputs are typed as a bare string too.
const Answer = Schema.Union([ChatCompletion, OwnAnswer, Schema.String])
type Answer = typeof Answer.Type

const StreamChunk = Schema.Struct({
  response: Schema.optional(Schema.NullOr(Schema.String)),
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        delta: Schema.optional(
          Schema.NullOr(Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) })),
        ),
        finish_reason: StatedReason,
      }),
    ),
  ),
  finish_reason: StatedReason,
  usage: Schema.optional(Schema.NullOr(TokenUsage)),
})

const StreamData = Schema.Union([Schema.Literal("[DONE]"), Schema.fromJsonString(StreamChunk)])
type StreamData = typeof StreamData.Type

const JsonText = Schema.fromJsonString(Schema.Json)

/** An answer read: its text, the finish reason the model stated, if any, and its tokens, if counted. */
interface Read {
  readonly text: string
  readonly stated: string | null | undefined
  readonly usage: TokenUsage | null | undefined
}

/**
 * A whole answer as `effect/ai`'s parts: its text, then a finish part with the reason and tokens.
 * Fails with `InvalidResponseError` for an answer in neither shape.
 */
export const completeAnswer = Effect.fnUntraced(function* (output: unknown) {
  const read = yield* readAnswer(output)
  const parts: Array<Response.PartEncoded> = [{ type: "text", text: read.text }, finishPart(read.stated, read.usage)]
  return parts
})

/**
 * A whole answer as one text delta, then the finish part: what `streamText` gives when Workers AI
 * answers at once though asked to stream, as some models do.
 */
export const completeAnswerStream = (
  output: unknown,
  id: string,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiErrorReason> =>
  Stream.unwrap(
    readAnswer(output).pipe(
      Effect.map((read) =>
        Stream.fromIterable<Response.StreamPartEncoded>([
          { type: "text-start", id },
          ...(read.text === "" ? [] : [{ type: "text-delta" as const, id, delta: read.text }]),
          { type: "text-end", id },
          finishPart(read.stated, read.usage),
        ]),
      ),
    ),
  )

/**
 * A streamed answer, the bytes of its server-sent events, as text deltas and a finish part. A
 * stream that ends before `[DONE]` with no reason stated finishes with `error`: it was cut off.
 * Fails with `InvalidResponseError` for an event it can't read, and with the binding's failure when
 * the stream breaks.
 */
export const streamedAnswer = (
  bytes: AsyncIterable<Uint8Array>,
  id: string,
): Stream.Stream<Response.StreamPartEncoded, AiError.AiErrorReason> => {
  const start: Response.TextStartPartEncoded = { type: "text-start", id }
  return Stream.fromAsyncIterable(bytes, failureOf).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.startsWith("data:")),
    Stream.map((line) => line.slice("data:".length).trim()),
    // `[DONE]` ends the answer: what follows isn't read, and a stream left open isn't waited on.
    Stream.takeUntil((data) => data === "[DONE]"),
    Stream.mapEffect((data) =>
      Schema.decodeEffect(StreamData)(data).pipe(
        Effect.mapError(
          () =>
            new AiError.InvalidResponseError({ description: "Workers AI streamed an event this package can't read" }),
        ),
      ),
    ),
    Stream.mapAccum(
      (): Progress => ({ done: false, stated: undefined, usage: undefined }),
      (progress: Progress, data: StreamData) => step(progress, data, id),
      { onHalt: (progress: Progress) => end(progress, id) },
    ),
    Stream.prepend([start]),
  )
}

/** How far a streamed answer has come. A chunk's `null` reason states none, so `stated` is never null. */
interface Progress {
  readonly done: boolean
  readonly stated: string | undefined
  readonly usage: TokenUsage | null | undefined
}

const step = (
  progress: Progress,
  data: StreamData,
  id: string,
): readonly [Progress, ReadonlyArray<Response.StreamPartEncoded>] => {
  if (data === "[DONE]") {
    return [{ ...progress, done: true }, []]
  }
  const choice = data.choices?.[0]
  const delta = choice?.delta?.content ?? data.response ?? ""
  const next: Progress = {
    done: false,
    stated: choice?.finish_reason ?? data.finish_reason ?? progress.stated,
    usage: data.usage ?? progress.usage,
  }
  return [next, delta === "" ? [] : [{ type: "text-delta", id, delta }]]
}

// A stream that ends before `[DONE]` with no reason stated was cut off.
const end = (progress: Progress, id: string): ReadonlyArray<Response.StreamPartEncoded> => {
  const cutOff = !progress.done && progress.stated === undefined
  return [{ type: "text-end", id }, finishPart(cutOff ? "error" : progress.stated, progress.usage)]
}

const readAnswer = Effect.fnUntraced(function* (output: unknown) {
  const answer = yield* Schema.decodeUnknownEffect(Answer)(output).pipe(
    Effect.mapError(
      () =>
        new AiError.InvalidResponseError({
          description: "Workers AI answered in neither shape this package reads: its own `response`, or `choices`",
        }),
    ),
  )
  return yield* readOf(answer)
})

const readOf = Effect.fnUntraced(function* (answer: Answer) {
  if (typeof answer === "string") {
    const read: Read = { text: answer, stated: undefined, usage: undefined }
    return read
  }
  if ("choices" in answer) {
    const choice = answer.choices[0]
    const read: Read = { text: choice?.message.content ?? "", stated: choice?.finish_reason, usage: answer.usage }
    return read
  }
  const text = yield* textOfResponse(answer.response)
  const read: Read = { text, stated: answer.finish_reason, usage: answer.usage }
  return read
})

// `response` is text, or in JSON mode the object itself, which `generateObject` reads back as JSON text.
const textOfResponse = (response: Schema.Json): Effect.Effect<string> => {
  if (typeof response === "string") {
    return Effect.succeed(response)
  }
  if (response === null) {
    return Effect.succeed("")
  }
  return Schema.encodeEffect(JsonText)(response).pipe(Effect.orDie)
}

const finishPart = (
  stated: string | null | undefined,
  usage: TokenUsage | null | undefined,
): Response.FinishPartEncoded => ({
  type: "finish",
  reason: finishReasonOf(stated),
  // Tokens Workers AI didn't count stay unknown, never zero.
  usage: {
    inputTokens: { total: usage?.prompt_tokens },
    outputTokens: { total: usage?.completion_tokens },
  },
})

// Workers AI's own shape usually states no reason: that is `unknown`, not a guess.
const finishReasonOf = (stated: string | null | undefined): Response.FinishReason => {
  switch (stated) {
    case undefined:
    case null:
      return "unknown"
    case "stop":
      return "stop"
    case "length":
    case "model_length":
      return "length"
    case "content_filter":
      return "content-filter"
    case "tool_calls":
    case "function_call":
      return "tool-calls"
    case "error":
      return "error"
    default:
      return "other"
  }
}
