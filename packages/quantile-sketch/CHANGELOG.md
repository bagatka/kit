# Changelog

## 0.1.0

First version: `sketchOf` sketches non-negative values at 0.5%, 1%, 2% (the default) or 5%,
counting the ones it refuses; `mergeSketches` merges sketches of one accuracy exactly, and refuses
different ones with `QuantileSketchesDiffer`; and `quantileOf` reads any quantile within the
sketch's accuracy, by nearest rank. `QuantileSketch` is the stored form, which names its accuracy.
