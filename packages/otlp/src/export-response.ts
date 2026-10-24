import { Effect } from "effect"

import { writeMessage, writerOf, writeStringField, writeVarintField, writtenOf } from "./protobuf-writer.ts"

/** The Content-Type of OTLP/HTTP protobuf requests and responses. */
export const protobufContentType = "application/x-protobuf"

/** What a receiver refused of an export, and why, as OTLP's `ExportPartialSuccess` says it. */
export interface PartialSuccess {
  /** How many spans, log records or data points were refused: a whole number from 0. */
  readonly rejected: number
  /** Why, for the exporter's logs; empty when there is nothing to say. */
  readonly errorMessage: string
}

/**
 * The body of the answer to an OTLP/HTTP export, `Export<Signal>ServiceResponse` as protobuf, which
 * has the same shape for traces, logs, and metrics: empty when everything was accepted, or with
 * `partialSuccess`, which exporters log and don't send again. A `rejected` that isn't a whole number
 * from 0 is a bug, and dies.
 */
export const exportResponse = (partialSuccess?: PartialSuccess): Effect.Effect<Uint8Array> => {
  if (partialSuccess === undefined) {
    return Effect.succeed(new Uint8Array(0))
  }
  const { rejected, errorMessage } = partialSuccess
  if (!Number.isSafeInteger(rejected) || rejected < 0) {
    return Effect.die(`An export response's rejected count is ${rejected}, not a whole number from 0`)
  }
  // ExportPartialSuccess partial_success = 1: int64 rejected_<items> = 1; string error_message = 2.
  const writer = writerOf()
  writeMessage(writer, 1, (inner) => {
    writeVarintField(inner, 1, rejected)
    writeStringField(inner, 2, errorMessage)
  })
  return Effect.succeed(writtenOf(writer))
}
