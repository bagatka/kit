import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"

import type { QuantileSketch } from "../src/index.ts"
import {
  countOf,
  emptySketch,
  mergeSketches,
  Quantile,
  QuantileSketch as QuantileSketchSchema,
  quantileOf,
  relativeAccuracy,
  sketchOf,
} from "../src/index.ts"

declare const performance: { readonly now: () => number }

// Request durations in milliseconds, spread like real ones: most fast, a long tail. Deterministic,
// so a failure repeats.
const durations = Array.from({ length: 10_000 }, (_, index) => {
  const unit = (Math.sin(index * 12.9898) * 43_758.5453) % 1
  return Math.exp(3 + 2.5 * Math.abs(unit) ** 2)
})

const sketched = (values: ReadonlyArray<number>): QuantileSketch => sketchOf(values).sketch

// The `percent`th value by nearest rank, in whole numbers: ceil(percent * count / 100).
const exactPercentile = (values: ReadonlyArray<number>, percent: number): number => {
  const sorted = values.toSorted((left, right) => left - right)
  return sorted[Math.max(Math.ceil((percent * sorted.length) / 100), 1) - 1] ?? Number.NaN
}

const read = (sketch: QuantileSketch, quantile: number): number =>
  Option.getOrElse(quantileOf(sketch, Quantile.make(quantile)), () => Number.NaN)

// Within 2%, up to floating point's last digits: a value on a bucket's edge is exactly 2% from it.
const isWithinAccuracy = (estimate: number, exact: number): boolean =>
  exact === 0 ? estimate === 0 : Math.abs(estimate - exact) / exact <= relativeAccuracy * (1 + 1e-12)

describe("quantile sketches", () => {
  it("read every quantile within 2% of the true value, by nearest rank", () => {
    const sketch = sketched(durations)
    for (let percent = 0; percent <= 100; percent += 1) {
      const exact = exactPercentile(durations, percent)
      assert.isTrue(isWithinAccuracy(read(sketch, percent / 100), exact), `p${percent}: ${exact}`)
    }
  })

  it("read p55 of 55 ones and 45 thousands as one, though 0.55 * 100 is 55.00000000000001", () => {
    const values = [...Array.from({ length: 55 }, () => 1), ...Array.from({ length: 45 }, () => 1_000)]
    assert.isTrue(isWithinAccuracy(read(sketched(values), 0.55), 1))
    assert.isTrue(isWithinAccuracy(read(sketched(values), 0.56), 1_000))
    // Nearest rank: p99 of fewer than 100 values is the largest, and p25 of 5 is the second,
    // ceil(1.25), not the nearest whole position.
    assert.isTrue(isWithinAccuracy(read(sketched([1, 2, 3, 4, 30]), 0.99), 30))
    assert.isTrue(isWithinAccuracy(read(sketched([1, 2, 3, 4, 30]), 0.25), 2))
  })

  it("merge into the sketch of all the values together", () => {
    // Every hundredth duration a zero, so that more than one part holds zeros.
    const values = durations.map((duration, index) => (index % 100 === 0 ? 0 : duration))
    const parts = [sketched(values.slice(0, 3_000)), emptySketch, sketched(values.slice(3_000))]
    assert.deepStrictEqual(mergeSketches(parts), sketched(values))
    assert.deepStrictEqual(mergeSketches([]), emptySketch)

    // A stored sketch may have empty buckets at its ends; the merge has none.
    const sketch = sketched(durations)
    const padded = { ...sketch, offset: sketch.offset - 2, counts: [0, 0, ...sketch.counts, 0] }
    assert.deepStrictEqual(mergeSketches([padded]), sketch)
  })

  it("stay small however many values they hold", () => {
    const sketch = sketched(durations)
    assert.strictEqual(countOf(sketch), 10_000)
    assert.isAtMost(sketch.counts.length, 200)
  })

  it("count values up to 1e-9 as zero, and refuse values that aren't finite and non-negative, saying how many", () => {
    const { refused, sketch } = sketchOf([0, -0, 1e-10, 1e-9, 5, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.strictEqual(refused, 3)
    assert.strictEqual(sketch.zeros, 4)
    assert.strictEqual(countOf(sketch), 5)
    assert.strictEqual(read(sketch, 0.8), 0)
    assert.isTrue(isWithinAccuracy(read(sketch, 1), 5))
    assert.isTrue(Option.isNone(quantileOf(emptySketch, Quantile.make(0.5))))
  })

  it("hold the largest finite values, and read them back finite", () => {
    const sketch = sketched([Number.MAX_VALUE, 1e300, 1e-9 * 1.5])
    for (const [quantile, exact] of [
      [1, Number.MAX_VALUE],
      [0.5, 1e300],
      [0, 1e-9 * 1.5],
    ] as const) {
      const estimate = read(sketch, quantile)
      assert.isTrue(Number.isFinite(estimate) && isWithinAccuracy(estimate, exact), `${quantile}: ${estimate}`)
    }
  })

  it.effect("decode from what they encode to, and refuse a stored sketch they can't have made", () =>
    Effect.gen(function* () {
      const sketch = sketched(durations)
      const stored = yield* Schema.encodeEffect(QuantileSketchSchema)(sketch)
      assert.deepStrictEqual(yield* Schema.decodeEffect(QuantileSketchSchema)(stored), sketch)

      // 2^53 - 1 values in all is the most a stored sketch holds; one more is refused below.
      const fullest = { ...sketch, zeros: Number.MAX_SAFE_INTEGER - countOf(sketch) }
      assert.deepStrictEqual(yield* Schema.decodeEffect(QuantileSketchSchema)(fullest), fullest)

      // Made for another accuracy; buckets past every finite value; a negative or fractional count.
      for (const [label, refused] of [
        ["another accuracy", { ...sketch, relativeAccuracy: 0.01 }],
        ["past every finite value", { ...sketch, offset: 17_744 }],
        ["below 1e-9", { ...sketch, offset: -1_000_000_000 }],
        ["a negative count", { ...sketch, counts: [...sketch.counts, -1] }],
        ["a fractional count", { ...sketch, zeros: 0.5 }],
        ["more values than counts exactly", { ...fullest, zeros: fullest.zeros + 1 }],
      ] as const) {
        const exit = yield* Schema.decodeUnknownEffect(QuantileSketchSchema)(refused).pipe(Effect.exit)
        assert.isTrue(Exit.isFailure(exit), label)
      }
    }),
  )

  it.effect("merge the widest sketches a store can hold quickly", () =>
    Effect.gen(function* () {
      // Every bucket a value can fall in, from 1e-9 to the largest finite value, in each of 100 sketches.
      const widest = yield* Schema.decodeEffect(QuantileSketchSchema)({
        relativeAccuracy,
        zeros: 0,
        offset: -519,
        counts: Array.from({ length: 18_264 }, () => 1),
      })
      const start = performance.now()
      const merged = mergeSketches(Array.from({ length: 100 }, () => widest))
      assert.strictEqual(countOf(merged), 1_826_400)
      assert.isTrue(Number.isFinite(read(merged, 1)))
      assert.isBelow(performance.now() - start, 2_000)
    }),
  )
})
