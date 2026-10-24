import { Effect } from "effect"
import type { Prompt } from "effect/ai"
import { AiError } from "effect/ai"

/** A message as Workers AI's text-generation models take it in `messages`. */
export interface WorkersAiMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** Tools aren't supported: a prompt or request that has them is refused with this. */
export const toolsUnsupported =
  "Workers AI tool calls aren't supported here: ask without a toolkit, and without tool calls or results in the prompt"

/**
 * The prompt's messages as Workers AI's `messages`: system, user and assistant messages with their
 * text. A message's text parts are joined as they are, as the models' chat templates join them; an
 * assistant's reasoning is left out. Fails with `InvalidUserInputError` for a file, or for a tool
 * call, result or message.
 */
export const messagesOf = (
  prompt: Prompt.Prompt,
): Effect.Effect<Array<WorkersAiMessage>, AiError.InvalidUserInputError> => Effect.forEach(prompt.content, messageOf)

const messageOf = (message: Prompt.Message): Effect.Effect<WorkersAiMessage, AiError.InvalidUserInputError> => {
  switch (message.role) {
    case "system":
      return Effect.succeed({ role: "system", content: message.content })
    case "user":
      return textOf(message.content).pipe(Effect.map((content) => ({ role: "user", content })))
    case "assistant":
      return textOf(message.content).pipe(Effect.map((content) => ({ role: "assistant", content })))
    case "tool":
      return Effect.fail(new AiError.InvalidUserInputError({ description: toolsUnsupported }))
  }
}

const textOf = (parts: ReadonlyArray<Prompt.Part>): Effect.Effect<string, AiError.InvalidUserInputError> => {
  const texts: Array<string> = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        texts.push(part.text)
        break
      // The model's own reasoning from an earlier answer: the models don't take it back.
      case "reasoning":
        break
      case "file":
        return Effect.fail(
          new AiError.InvalidUserInputError({
            description: `Workers AI's text models take text here, not files: this prompt has a ${part.mediaType} file`,
          }),
        )
      case "tool-call":
      case "tool-result":
      case "tool-approval-request":
      case "tool-approval-response":
        return Effect.fail(new AiError.InvalidUserInputError({ description: toolsUnsupported }))
    }
  }
  return Effect.succeed(texts.join(""))
}
