import { Option, Schema } from "effect"

/** How far a quantile read from a sketch may be from the true value, relative to it: 2%. */
export const relativeAccuracy = 0.02

// Bucket `i` holds the values in (γ^(i-1), γ^i]. Any value in it is within `relativeAccuracy` of the
// bucket's representative value, 2γ^i / (γ + 1) (DDSketch).
const gamma = (1 + relativeAccuracy) / (1 - relativeAccuracy)
const logGamma = Math.log(gamma)

// Values at or below this count as zero: smaller than anything a duration or a size is measured in.
const smallest = 1e-9

const bucketOf = (value: number): number => Math.ceil(Math.log(value) / logGamma)

// The buckets a finite value above `smallest` can fall in, with one to spare on each side, so that
// a last-digit difference between runtimes' logarithms never puts a value outside them.
const lowestBucket = bucketOf(smallest) - 1
const highestBucket = bucketOf(Number.MAX_VALUE) + 1

// The representative value of `bucket`, kept finite: past the largest finite value, that value is
// as close to every value of the bucket as the representative is.
const representativeOf = (bucket: number): number =>
  Math.min(Math.exp(bucket * logGamma) * (2 / (gamma + 1)), Number.MAX_VALUE)

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * A mergeable sketch of non-negative values, from which any quantile can be read to within
 * `relativeAccuracy` of the true value, up to floating point's last digits. Plain data, so it can
 * be stored and sent as it is; decoding one refuses a sketch made for another accuracy, buckets
 * past one to spare beyond those any finite value above 1e-9 falls in, and more than 2^53 - 1
 * values in all, past which counts aren't exact. Its size grows with the spread of its values,
 * about 58 buckets for each factor of 10, not with their number, and is at most 18,264 buckets.
 */
export const QuantileSketch = Schema.Struct({
  /** The accuracy it was made for, so that a sketch made for another is never misread. */
  relativeAccuracy: Schema.Literal(relativeAccuracy),
  /** How many values were zero, or at most 1e-9. */
  zeros: Count,
  /** The bucket of `counts[0]`. */
  offset: Schema.Int.check(Schema.isBetween({ minimum: lowestBucket, maximum: highestBucket })),
  /** How many values fell in each bucket, from `offset` on. */
  counts: Schema.Array(Count).check(Schema.isMaxLength(highestBucket - lowestBucket + 1)),
}).check(
  Schema.makeFilter((sketch) => {
    if (sketch.offset + sketch.counts.length - 1 > highestBucket) {
      return "its last bucket is past every finite value's"
    }
    return (
      countOf(sketch) <= Number.MAX_SAFE_INTEGER || "it holds more than 2^53 - 1 values, past which counts aren't exact"
    )
  }),
)
export type QuantileSketch = typeof QuantileSketch.Type

/** Which quantile to read: 0.5 for the median, 0.95 for p95. From 0 to 1. */
export const Quantile = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(Schema.brand("Quantile"))
export type Quantile = typeof Quantile.Type

/** The sketch of no values. */
export const emptySketch: QuantileSketch = { relativeAccuracy, zeros: 0, offset: 0, counts: [] }

const fromBuckets = (zeros: number, buckets: ReadonlyMap<number, number>): QuantileSketch => {
  let first = Number.POSITIVE_INFINITY
  let last = Number.NEGATIVE_INFINITY
  for (const bucket of buckets.keys()) {
    first = Math.min(first, bucket)
    last = Math.max(last, bucket)
  }
  if (buckets.size === 0) {
    return { ...emptySketch, zeros }
  }
  const counts = Array.from({ length: last - first + 1 }, (_, position) => buckets.get(first + position) ?? 0)
  return { relativeAccuracy, zeros, offset: first, counts }
}

/** What `sketchOf` made of some values. */
export interface Sketched {
  readonly sketch: QuantileSketch
  /** How many values were negative, `NaN`, or infinite, which the sketch doesn't hold. */
  readonly refused: number
}

/**
 * The sketch of `values`, in one pass, and how many of them it refused for not being finite and
 * non-negative: the caller decides what those mean, such as a clock that went backwards.
 */
export const sketchOf = (values: Iterable<number>): Sketched => {
  const buckets = new Map<number, number>()
  let zeros = 0
  let refused = 0
  for (const value of values) {
    const holds = Number.isFinite(value) && value >= 0
    if (!holds) {
      refused += 1
    } else if (value <= smallest) {
      zeros += 1
    } else {
      const bucket = bucketOf(value)
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
    }
  }
  return { sketch: fromBuckets(zeros, buckets), refused }
}

/**
 * One sketch of all the values of `sketches`, exactly as if they had been sketched together on one
 * engine. Takes time linear in their buckets.
 */
export const mergeSketches = (sketches: Iterable<QuantileSketch>): QuantileSketch => {
  // Not handled: sketches of more than 2^53 - 1 values in all, which no store reaches: their
  // merge's counts aren't exact, and the Schema refuses to store it. Exact ones would need bigints.
  const buckets = new Map<number, number>()
  let zeros = 0
  for (const sketch of sketches) {
    zeros += sketch.zeros
    for (const [position, count] of sketch.counts.entries()) {
      if (count > 0) {
        buckets.set(sketch.offset + position, (buckets.get(sketch.offset + position) ?? 0) + count)
      }
    }
  }
  return fromBuckets(zeros, buckets)
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
 * The `quantile` of the values in `sketch`, within `relativeAccuracy` of the true value, by nearest
 * rank: the value at position `ceil(quantile * count)` of the values in order, the first for 0. So
 * p99 of fewer than 100 values is the largest, as "the slowest 1%" reads. None for no values. Takes
 * time linear in the sketch's buckets.
 */
export const quantileOf = (sketch: QuantileSketch, quantile: Quantile): Option.Option<number> => {
  const count = countOf(sketch)
  if (count === 0) {
    return Option.none()
  }
  const position = positionOf(quantile, count)
  if (position <= sketch.zeros) {
    return Option.some(0)
  }
  let seen = sketch.zeros
  for (const [index, inBucket] of sketch.counts.entries()) {
    seen += inBucket
    if (seen >= position) {
      return Option.some(representativeOf(sketch.offset + index))
    }
  }
  // The position is at most the count, which the last bucket reaches, so the loop has returned.
  return Option.some(representativeOf(sketch.offset + sketch.counts.length - 1))
}
