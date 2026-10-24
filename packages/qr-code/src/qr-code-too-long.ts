import { Schema } from "effect"

/**
 * The text takes more UTF-8 bytes than a QR code holds: `limit`, 2331, what version 40 holds at
 * level M. `byteLength` is how many the text takes. Encoding it again won't help: shorten the text,
 * or encode a short link to it instead.
 */
export class QrCodeTooLong extends Schema.TaggedError<QrCodeTooLong>()("QrCodeTooLong", {
  byteLength: Schema.Int,
  limit: Schema.Int,
}) {
  override get message(): string {
    return `The text takes ${this.byteLength} bytes of UTF-8, and a QR code holds at most ${this.limit}`
  }
}
