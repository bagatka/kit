import { Option, Result, Schema } from "effect"

/**
 * How far a quantile read from a sketch may be from the true value, relative to it: 0.5%, 1%, 2%
 * (the default) or 5%. Halving it doubles a sketch's buckets, and so its size and the time to merge
 * and read it; sketching costs the same at any accuracy. Finer than 0.5% isn't offered: clocks and
 * the spread between one minute's p99 and the next are coarser, and data that must be exact is
 * few enough values to keep and sort.
 */
export const RelativeAccuracy = Schema.Literals([0.005, 0.01, 0.02, 0.05])
export type RelativeAccuracy = typeof RelativeAccuracy.Type

// Values at or below this count as zero: smaller than anything a duration or a size is measured in.
const smallest = 1e-9

// What an accuracy's buckets are. Bucket `i` holds the values in (γ^(i-1), γ^i]; any value in it is
// within the accuracy of the bucket's representative value, 2γ^i / (γ + 1) (DDSketch). A finite
// value above `smallest` falls in `lowest + 1` to `highest - 1`: one to spare on each side, so a
// last-digit difference between runtimes' logarithms never puts a value outside them.
interface Buckets {
  readonly logGamma: number
  readonly scale: number
  readonly lowest: number
  readonly highest: number
}

const bucketsOf = (accuracy: RelativeAccuracy): Buckets => {
  const gamma = (1 + accuracy) / (1 - accuracy)
  const logGamma = Math.log(gamma)
  return {
    logGamma,
    scale: 2 / (gamma + 1),
    lowest: Math.ceil(Math.log(smallest) / logGamma) - 1,
    highest: Math.ceil(Math.log(Number.MAX_VALUE) / logGamma) + 1,
  }
}

const buckets = new Map(RelativeAccuracy.literals.map((accuracy) => [accuracy, bucketsOf(accuracy)]))

// The buckets of an accuracy the type allows. A JavaScript caller's other number is a bug in that
// caller, and throws, saying which accuracies there are.
const bucketsFor = (accuracy: RelativeAccuracy): Buckets => {
  const found = buckets.get(accuracy)
  if (found === undefined) {
    throw new RangeError(`A sketch's relativeAccuracy is one of ${RelativeAccuracy.literals.join(", ")}`)
  }
  return found
}

const bucketOf = (value: number, { logGamma }: Buckets): number => Math.ceil(Math.log(value) / logGamma)

// The representative value of `bucket`, kept finite: past the largest finite value, that value is
// as close to every value of the bucket as the representative is.
const representativeOf = (bucket: number, { logGamma, scale }: Buckets): number =>
  Math.min(Math.exp(bucket * logGamma) * scale, Number.MAX_VALUE)

// The most buckets a sketch of any accuracy can have: the finest's.
const mostBuckets = Math.max(...[...buckets.values()].map(({ lowest, highest }) => highest - lowest + 1))

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A mergeable sketch of non-negative values, from which any quantile can be read to within its
 * `relativeAccuracy` of the true value, up to floating point's last digits. Plain data, so it can
 * be stored and sent as it is; decoding one refuses an accuracy not on the list, buckets past one
 * to spare beyond those any finite value above 1e-9 falls in at its accuracy, and more than
 * 2^53 - 1 values in all, past which counts aren't exact. Its size grows with the spread of its
 * values, not with their number: at 2%, about 58 buckets for each factor of 10, and at most 18,264
 * buckets; twice that at 1%, four times at 0.5%.
 */
export const QuantileSketch = Schema.Struct({
  /** The accuracy it was made with, which reading and merging it follow. */
  relativeAccuracy: RelativeAccuracy,
  /** How many values were zero, or at most 1e-9. */
  zeros: Count,
  /** The bucket of `counts[0]`. */
  offset: Schema.Int,
  /** How many values fell in each bucket, from `offset` on. */
  counts: Schema.Array(Count).check(Schema.isMaxLength(mostBuckets)),
}).check(
  Schema.makeFilter((sketch) => {
    const { lowest, highest } = bucketsFor(sketch.relativeAccuracy)
    if (sketch.offset < lowest || sketch.offset + sketch.counts.length - 1 > highest) {
      return "its buckets are past every finite value's at its accuracy"
    }
    return (
      countOf(sketch) <= Number.MAX_SAFE_INTEGER || "it holds more than 2^53 - 1 values, past which counts aren't exact"
    )
  }),
)
export type QuantileSketch = typeof QuantileSketch.Type

/**
 * Sketches that hold values were made with different accuracies, which can't be merged exactly:
 * `accuracies` are theirs, each once. Sketch every series with one accuracy.
 */
export class QuantileSketchesDiffer extends Schema.TaggedError<QuantileSketchesDiffer>()("QuantileSketchesDiffer", {
  accuracies: Schema.Array(RelativeAccuracy),
}) {
  override get message(): string {
    return `Sketches of different accuracies can't be merged: ${this.accuracies.join(", ")}`
  }
}

/** Which quantile to read: 0.5 for the median, 0.95 for p95. From 0 to 1. */
export const Quantile = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.brand("Quantile"))
export type Quantile = typeof Quantile.Type

/** The sketch of no values, at 2%. It merges with sketches of any accuracy, since it holds nothing. */
export const emptySketch: QuantileSketch = { relativeAccuracy: 0.02, zeros: 0, offset: 0, counts: [] }

const fromBuckets = (
  relativeAccuracy: RelativeAccuracy,
  zeros: number,
  counted: ReadonlyMap<number, number>,
): QuantileSketch => {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const bucket of counted.keys()) {
    first = Math.min(first, bucket)
    last = Math.max(last, bucket)
  }
  if (counted.size === 0) {
    return { relativeAccuracy, zeros, offset: 0, counts: [] }
  }
  const counts = Array.from({ length: last - first + 1 }, (_, position) => counted.get(first + position) ?? 0)
  return { relativeAccuracy, zeros, offset: first, counts }
}

/** What `sketchOf` made of some values. */
export interface Sketched {
  readonly sketch: QuantileSketch
  /** How many values were negative, `NaN`, or infinite, which the sketch doesn't hold. */
  readonly refused: number
}

/**
 * The sketch of `values`, in one pass, at `relativeAccuracy` (2% unless given), and how many of
 * them it refused for not being finite and non-negative: the caller decides what those mean, such
 * as a clock that went backwards. One logarithm per value, at any accuracy.
 */
export const sketchOf = (
  values: Iterable<number>,
  options?: { readonly relativeAccuracy?: RelativeAccuracy },
): Sketched => {
  const relativeAccuracy = options?.relativeAccuracy ?? 0.02
  const accuracyBuckets = bucketsFor(relativeAccuracy)
  const counted = new Map<number, number>()
  let zeros = 0
  let refused = 0
  for (const value of values) {
    const holds = Number.isFinite(value) && value >= 0
    if (!holds) {
      refused += 1
    } else if (value <= smallest) {
      zeros += 1
    } else {
      const bucket = bucketOf(value, accuracyBuckets)
      counted.set(bucket, (counted.get(bucket) ?? 0) + 1)
    }
  }
  return { sketch: fromBuckets(relativeAccuracy, zeros, counted), refused }
}

/**
 * One sketch of all the values of `sketches`, exactly as if they had been sketched together on one
 * engine, at their accuracy. Sketches that hold no values merge with any; sketches that hold values
 * at different accuracies fail with `QuantileSketchesDiffer`. No sketches give `emptySketch`. Takes
 * time linear in their buckets.
 */
export const mergeSketches = (
  sketches: Iterable<QuantileSketch>,
): Result.Result<QuantileSketch, QuantileSketchesDiffer> => {
  const holding = [...sketches].filter((sketch) => countOf(sketch) > 0)
  const accuracies = [...new Set(holding.map((sketch) => sketch.relativeAccuracy))]
  const [relativeAccuracy, ...others] = accuracies
  if (relativeAccuracy === undefined) {
    return Result.succeed(emptySketch)
  }
  if (others.length > 0) {
    return Result.fail(new QuantileSketchesDiffer({ accuracies }))
  }
  // Not handled: sketches of more than 2^53 - 1 values in all, which no store reaches: their
  // merge's counts aren't exact, and the Schema refuses to store it. Exact ones would need bigints.
  const counted = new Map<number, number>()
  let zeros = 0
  for (const sketch of holding) {
    zeros += sketch.zeros
    for (const [position, count] of sketch.counts.entries()) {
      if (count > 0) {
        counted.set(sketch.offset + position, (counted.get(sketch.offset + position) ?? 0) + count)
      }
    }
  }
  return Result.succeed(fromBuckets(relativeAccuracy, zeros, counted))
}

/** How many values `sketch` holds. */
export function countOf(sketch: { readonly zeros: number; readonly counts: ReadonlyArray<number> }): number {
  return sketch.counts.reduce((total, count) => total + count, sketch.zeros)
}

// The position of the value asked for among `count` values in order, from 1, by nearest rank:
// ceil(quantile * count). The product is computed in floating point, where 0.55 * 100 is
// 55.00000000000001, so a product within a few units of its last digit of a whole number is that
// number.
const positionOf = (quantile: number, count: number): number => {
  const product = quantile * count
  const whole = Math.round(product)
  const isWhole = Math.abs(product - whole) <= 4 * Number.EPSILON * product
  return Math.max(isWhole ? whole : Math.ceil(product), 1)
}

/**
 * The `quantile` of the values in `sketch`, within its `relativeAccuracy` of the true value, by
 * nearest rank: the value at position `ceil(quantile * count)` of the values in order, the first
 * for 0. So p99 of fewer than 100 values is the largest, as "the slowest 1%" reads. None for no
 * values. Takes time linear in the sketch's buckets.
 */
export const quantileOf = (sketch: QuantileSketch, quantile: Quantile): Option.Option<number> => {
  const count = countOf(sketch)
  if (count === 0) {
    return Option.none()
  }
  const accuracyBuckets = bucketsFor(sketch.relativeAccuracy)
  const position = positionOf(quantile, count)
  if (position <= sketch.zeros) {
    return Option.some(0)
  }
  let seen = sketch.zeros
  for (const [index, inBucket] of sketch.counts.entries()) {
    seen += inBucket
    if (seen >= position) {
      return Option.some(representativeOf(sketch.offset + index, accuracyBuckets))
    }
  }
  // The position is at most the count, which the last bucket reaches, so the loop has returned.
  return Option.some(representativeOf(sketch.offset + sketch.counts.length - 1, accuracyBuckets))
}
