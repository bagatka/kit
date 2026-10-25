# @bagatka/quantile-sketch

Quantiles such as p50 and p99 of any number of values, such as request durations, from small
sketches that merge, with Effect.

## Install

```sh
npm install @bagatka/quantile-sketch effect
```

Its peer dependency is `effect`, at the minor version it is built with: your program uses that one
too. It is plain JavaScript and needs nothing from the platform, so it runs everywhere: Cloudflare
Workers, browsers, Deno, Bun, and Node.

## Use it

```ts
import { mergeSketches, Quantile, QuantileSketch, quantileOf, sketchOf } from "@bagatka/quantile-sketch"
import { Result, Schema } from "effect"

declare const durationsInMs: ReadonlyArray<number> // one batch, as it arrived
declare const storedRows: unknown // the period's sketches, as the store gave them back

// At ingest: one sketch per batch, stored as plain data.
const { sketch, refused } = sketchOf(durationsInMs)
// sketch: QuantileSketch, about 230 buckets for durations from 1 ms to 10 s, whatever their number.
// refused: how many durations were negative, NaN, or infinite, which the sketch doesn't hold.

// When asked: decode what was stored, merge the period's sketches, then read.
const stored = Schema.decodeUnknownResult(Schema.Array(QuantileSketch))(storedRows)
if (Result.isSuccess(stored)) {
  const p95 = quantileOf(mergeSketches(stored.success), Quantile.make(0.95))
  // Option.some(480.2): within 2% of the true p95. Option.none() when there were no values.
}
// A failure is a SchemaError: a row made for another accuracy, or with buckets no finite value falls in.
```

## Contract

`src/index.ts`. Callers make sketches from values, merge them, and read quantiles and counts. A
sketch is a Schema, so it can be stored and sent as it is.

## Does not own

- **Means, sums, and exact minimums and maximums.** A sketch keeps counts in buckets, which give
  every quantile within 2%, p0 and p100 included; a caller that needs an exact sum keeps it beside
  the sketch.
- **What a refused value means:** a negative duration from a clock that went backwards is the
  caller's to report.

## Depends on

`effect`, for `Option` and the Schemas.

## Decisions and constraints

- **Doesn't trust values or stored sketches.** Any number may be given, and what isn't a
  non-negative finite value is refused and counted; a sketch read back or sent by others is decoded
  by `QuantileSketch`, which refuses one made for another accuracy or with buckets no finite value
  falls in, so none has more than 18,264. **Trusts its caller.**
- **DDSketch with logarithmic buckets and no collapsing** (Masson, Rim and Lee, 2019). Every
  quantile is within 2% of the true value, and merging is exact: merging sketches gives the sketch of
  all their values together, in any order and grouping, when they were made on one engine. V8 and
  JavaScriptCore compute logarithms differently in the last digit, so a value on a bucket's edge may
  fall in the next bucket on the other, as 62 of 255,653 such values did: still within 2%.
- **Nearest rank.** A quantile is the value at position `ceil(q * count)`, so p99 of fewer than 100
  values is the largest, as "the slowest 1%" reads. The product is floating point, where
  `0.55 * 100` is `55.00000000000001`; a product that close to a whole number is taken as it.
- **Non-negative values only:** durations, sizes, counts. Zero, and anything up to 1e-9, counts in a
  bucket of its own, read back as zero; negative, `NaN`, and infinite values are refused and
  counted. The largest finite values are held, and read back finite.
- **Size follows the spread of the values,** about 58 buckets per factor of 10, not their number:
  durations from 1 ms to 10 s take about 230 buckets, and no sketch can have more than 18,264, the
  buckets any finite value above 1e-9 falls in and one to spare on each side.
- **At most 2^53 - 1 values in all,** past which a JavaScript number counts them no longer exactly:
  a stored sketch with more is refused, and a merge of more, which no store reaches, isn't exact.
- **The stored form names its accuracy,** `relativeAccuracy: 0.02`, so a sketch made for another
  accuracy is refused when decoded, never misread.
- **Cost:** sketching takes one logarithm per value; merging and reading take time linear in the
  buckets. On Node 26 and Bun 1.4 on an M-series Mac: sketching 10,000 durations takes 0.2 to
  0.5 ms; merging 100 of the widest sketches, 17,860 buckets each, 21 to 35 ms; reading a quantile
  of one, about 0.1 ms. Durations from 1 ms to 10 s take 231 buckets, 749 bytes as JSON.
