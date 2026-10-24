import { Predicate } from "effect"
import { AiError } from "effect/ai"

/** What a thrown error says: its message. */
export const messageOf = (cause: unknown): string => {
  if (Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message)) {
    return cause.message
  }
  return "Workers AI failed without saying why"
}

/**
 * The reason a call to the binding failed. The binding throws errors whose message carries Workers
 * AI's code, such as `3040: Capacity temporarily exceeded, please try again.`, sometimes after a
 * name (`InferenceUpstreamError: 3040: ...`), and no HTTP status. Each documented code becomes the
 * reason Effect's own Cloudflare client gives the HTTP status Cloudflare documents for it
 * (https://developers.cloudflare.com/workers-ai/platform/errors/); any other failure is an
 * `UnknownError` with the binding's message.
 */
export const failureOf = (cause: unknown): AiError.AiErrorReason => {
  const message = messageOf(cause)
  if (jsonModeUnmet.test(message)) {
    return new AiError.InvalidOutputError({ description: message, metadata: { workersAi: { message } } })
  }
  for (const code of codesIn(message)) {
    const reason = reasonFor(code, message)
    if (reason !== undefined) {
      return reason
    }
  }
  return new AiError.UnknownError({ description: message, metadata: { workersAi: { message } } })
}

// JSON mode's documented failure, when the model couldn't answer to the schema.
const jsonModeUnmet = /JSON Mode couldn.t be met/i

// Every "<digits>:" in the message, as a request ID may come first. The binding writes the code
// into the message and sets no `code` of its own.
const codesIn = (message: string): ReadonlyArray<number> =>
  Array.from(message.matchAll(/\b(\d{4})\s*:/g), (match) => Number(match[1]))

// The HTTP status Cloudflare documents for each of Workers AI's codes
// (developers.cloudflare.com/workers-ai/platform/errors/); the binding throws the code, not the status.
const statusOf: ReadonlyMap<number, number> = new Map([
  // No such model, invalid data, a fine-tune's files missing, an incomplete request.
  [5007, 400],
  [5004, 400],
  [3039, 400],
  [3003, 400],
  // The account may not use the model: private, terms not agreed, blocked, Workers Paid needed.
  [5018, 403],
  [5016, 403],
  [3023, 403],
  [3041, 403],
  [5035, 403],
  // An invalid model name.
  [3042, 404],
  // A deprecated SDK; LoRA unsupported.
  [5019, 405],
  [5005, 405],
  // Timed out; aborted.
  [3007, 408],
  [3008, 408],
  // Too large.
  [3006, 413],
  // The free plan's daily neurons used up; out of capacity, also what `rejectIfBusy` answers.
  [3036, 429],
  [3040, 429],
])

// A documented code's reason, as Effect's own Cloudflare client gives it for the code's status over
// REST: 404 an `InvalidRequestError`, the rest by `AiError.reasonFromHttpStatus`. So a program that
// moves between the binding and Effect's REST client sees the same failures.
const reasonFor = (code: number, message: string): AiError.AiErrorReason | undefined => {
  const status = statusOf.get(code)
  if (status === undefined) {
    return undefined
  }
  const metadata = { workersAi: { code, message } }
  return status === 404
    ? new AiError.InvalidRequestError({ description: message, metadata })
    : AiError.reasonFromHttpStatus({ status, description: message, metadata })
}
