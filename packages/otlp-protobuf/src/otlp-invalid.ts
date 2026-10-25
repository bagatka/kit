import { Schema } from "effect"

/**
 * The body isn't the OTLP export it should be. `reason` says what is wrong and at which byte, for
 * logs, and never quotes the body. Sending it again won't help: answer the exporter with a 400.
 */
export class OtlpInvalid extends Schema.TaggedError<OtlpInvalid>()("OtlpInvalid", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The body isn't an OTLP export: ${this.reason}`
  }
}
