import { Schema } from "effect"

/**
 * A Workers AI model's ID, as its catalog writes it: `@cf/` or `@hf/`, its author, and its name,
 * such as `@cf/meta/llama-4-scout-17b-16e-instruct`.
 */
export const WorkersAiModel = Schema.String.check(
  Schema.isPattern(/^@(cf|hf)\/[a-z0-9-]+\/[A-Za-z0-9._-]+$/, {
    expected:
      "a Workers AI model ID: @cf/ or @hf/, its author and its name, such as @cf/meta/llama-4-scout-17b-16e-instruct",
  }),
).pipe(Schema.brand("WorkersAiModel"))
export type WorkersAiModel = typeof WorkersAiModel.Type
