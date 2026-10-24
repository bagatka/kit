/**
 * Quantiles of any number of values, such as request durations, from small sketches that merge:
 * sketch each batch, store the sketches, and read p50 or p99 of any span of them later.
 */
export type { Sketched } from "./quantile-sketch.ts"
export {
  countOf,
  emptySketch,
  mergeSketches,
  Quantile,
  QuantileSketch,
  quantileOf,
  relativeAccuracy,
  sketchOf,
} from "./quantile-sketch.ts"
