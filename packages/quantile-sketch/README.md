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

// At ingest: one sketch per batch, stored as plain data. 2% unless you choose another accuracy.
const { sketch, refused } = sketchOf(durationsInMs)
// sketch: QuantileSketch, 231 buckets for durations from 1 ms to 10 s, whatever their number.
// refused: how many durations were negative, NaN, or infinite, which the sketch doesn't hold.

// When asked: decode what was stored, merge the period's sketches, then read.
const stored = Schema.decodeUnknownResult(Schema.Array(QuantileSketch))(storedRows)
const period = Result.flatMap(stored, mergeSketches)
if (Result.isSuccess(period)) {
  const p95 = quantileOf(period.success, Quantile.make(0.95))
  // Option.some(480.2): within 2% of the true p95. Option.none() when there were no values.
}
// A failure is a SchemaError, for a row that no sketch of its accuracy can be; or
// QuantileSketchesDiffer, for rows made with different accuracies.
```

## Choosing an accuracy

```ts
const { sketch: precise } = sketchOf(durationsInMs, { relativeAccuracy: 0.01 })
```

Every sketch records the accuracy it was made with, so reading and decoding need no setting. Choose
one per series and keep it: sketches of different accuracies can't be merged exactly, so
`mergeSketches` refuses them with `QuantileSketchesDiffer`, which names them. Sketches that hold no
values merge with any.

Halving the accuracy doubles a sketch's buckets, and so its size and the time to merge and read it;
sketching costs the same at any accuracy. Measured with durations from 1 ms to 10 s, on Node 26 and
Bun 1.4 on an M-series Mac:

| `relativeAccuracy` | Buckets | JSON | Most buckets any sketch has | Merging 100 of those | For |
|---|---|---|---|---|---|
| `0.005` | 921 | 2.5 KB | 73,053 | 144 to 173 ms | Precise numbers: billing estimates, SLAs |
| `0.01` | 461 | 1.4 KB | 36,527 | 59 to 83 ms | Datadog's default |
| `0.02`, the default | 231 | 0.7 KB | 18,264 | 27 to 40 ms | Latency dashboards and alerts |
| `0.05` | 93 | 0.4 KB | 7,302 | 11 to 16 ms | Very many series, where storage is tight |

Sketching 10,000 values takes 0.15 to 0.45 ms at any of them. Need better than 0.5%? Then you have
few enough values to keep them all and sort them: clocks round to 100 µs in browsers and stand still
in Workers while code runs, and one minute's p99 differs from the next by more than 0.5%.


## Contract

`src/index.ts`. Callers make sketches from values, at an accuracy of their choice, merge them, and
read quantiles and counts. A sketch is a Schema, so it can be stored and sent as it is.

## Does not own

- **Means, sums, and exact minimums and maximums.** A sketch keeps counts in buckets, which give
  every quantile within its accuracy, p0 and p100 included; a caller that needs an exact sum keeps it beside
  the sketch.
- **What a refused value means:** a negative duration from a clock that went backwards is the
  caller's to report.

## Depends on

`effect`, for `Option` and the Schemas.

## Decisions and constraints

- **Doesn't trust values or stored sketches.** Any number may be given, and what isn't a
  non-negative finite value is refused and counted; a sketch read back or sent by others is decoded
  by `QuantileSketch`, which refuses an accuracy not on the list, or buckets no finite value falls
  in at its accuracy, so none has more than 73,053. **Trusts its caller,** whose accuracy the type
  limits to the list; a JavaScript caller's other number is a bug, and throws a `RangeError` that
  names the list.
- **DDSketch with logarithmic buckets and no collapsing** (Masson, Rim and Lee, 2019). Every
  quantile is within the sketch's accuracy of the true value, and merging is exact: merging sketches gives the sketch of
  all their values together, in any order and grouping, when they were made on one engine. V8 and
  JavaScriptCore compute logarithms differently in the last digit, so a value on a bucket's edge may
  fall in the next bucket on the other, as 62 of 255,653 such values did: still within the accuracy.
- **Four accuracies, not any number:** 0.5%, 1%, 2% and 5%, as `RelativeAccuracy`. A free number
  would let a sketch sent by others claim one that takes millions of buckets, and each of the four
  has a known largest size. 2% is the default: twice as fine as Prometheus's native histograms and
  OpenTelemetry's exponential histograms by default, at half the size of 1%.
- **Different accuracies never merge.** Merging them exactly is impossible, and folding the finer
  into the coarser would hide a guarantee that got worse; empty sketches hold nothing to misread,
  so they merge with any.
- **Nearest rank.** A quantile is the value at position `ceil(q * count)`, so p99 of fewer than 100
  values is the largest, as "the slowest 1%" reads. The product is floating point, where
  `0.55 * 100` is `55.00000000000001`; a product that close to a whole number is taken as it.
- **Non-negative values only:** durations, sizes, counts. Zero, and anything up to 1e-9, counts in a
  bucket of its own, read back as zero; negative, `NaN`, and infinite values are refused and
  counted. The largest finite values are held, and read back finite.
- **Size follows the spread of the values,** not their number: at 2%, about 58 buckets per factor
  of 10. No sketch has more buckets than any finite value above 1e-9 falls in at its accuracy, with
  one to spare on each side: the table's "most buckets".
- **At most 2^53 - 1 values in all,** past which a JavaScript number counts them no longer exactly:
  a stored sketch with more is refused, and a merge of more, which no store reaches, isn't exact.
- **The stored form names its accuracy,** `relativeAccuracy: 0.02`, so it is read with its own
  buckets, and a merge with another accuracy is refused, never misread.
- **Cost:** sketching takes one logarithm per value; merging and reading take time linear in the
  buckets, as measured in "Choosing an accuracy".
