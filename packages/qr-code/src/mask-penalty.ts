// The four penalty rules of ISO/IEC 18004:2015, 7.8.3, which score how much a masked symbol could
// confuse a reader. Their weights are the standard's N1 to N4.

// Rule 3 counts finder-like patterns: runs of dark, light, dark, light and dark in the ratio
// 1:1:3:1:1, of any unit, with a light area 4 units wide before or after them, each counted. The
// quiet zone around the symbol is light, so a pattern at its edge has one.

// How many finder-like patterns end at a light run, 0, 1 or 2, from the 7 runs that end with it,
// the latest first: dark runs in the ratio 1:1:3:1:1 between light ones, with 4 units of light
// after them and at least 1 before, or 4 before and at least 1 after.
const finderPatternsOf = (
  after: number,
  unit: number,
  light: number,
  middle: number,
  otherLight: number,
  first: number,
  before: number,
): number => {
  if (unit === 0 || light !== unit || middle !== unit * 3 || otherLight !== unit || first !== unit) {
    return 0
  }
  return (after >= unit * 4 && before >= unit ? 1 : 0) + (before >= unit * 4 && after >= unit ? 1 : 0)
}

// Rules 1 and 3 along one row or column: `size` modules from `start`, `stride` apart. Rule 1: each
// run of 5 or more modules of one color, 3 plus 1 for each module beyond 5.
const linePenaltyOf = (modules: Uint8Array, start: number, stride: number, size: number): number => {
  let penalty = 0
  // The last 7 runs' lengths, the latest in `r0`, light and dark in turn, 0 until there are 7. The
  // line's first run, light, is the quiet zone before it too, and its last the quiet zone after it.
  let r0 = 0
  let r1 = 0
  let r2 = 0
  let r3 = 0
  let r4 = 0
  let r5 = 0
  let r6 = 0
  let color = 0
  let run = 0
  for (let index = 0; index < size; index += 1) {
    const module = modules[start + index * stride] ?? 0
    if (module === color) {
      run += 1
      if (run === 5) {
        penalty += 3
      } else if (run > 5) {
        penalty += 1
      }
    } else {
      r6 = r5
      r5 = r4
      r4 = r3
      r3 = r2
      r2 = r1
      r1 = r0
      r0 = r1 === 0 ? run + size : run
      penalty += color === 0 ? 40 * finderPatternsOf(r0, r1, r2, r3, r4, r5, r6) : 0
      color = module
      run = 1
    }
  }
  // The line's end: its last dark run, if it ends dark, then the quiet zone's light after it.
  if (color === 1) {
    r6 = r5
    r5 = r4
    r4 = r3
    r3 = r2
    r2 = r1
    r1 = r0
    r0 = run
    run = 0
  }
  r6 = r5
  r5 = r4
  r4 = r3
  r3 = r2
  r2 = r1
  r1 = r0
  r0 = run + size
  return penalty + 40 * finderPatternsOf(r0, r1, r2, r3, r4, r5, r6)
}

// Rule 2: each 2 by 2 block of one color, 3. A larger block of one color counts as every 2 by 2
// block in it, which is what the standard's 3 * (m - 1) * (n - 1) for an m by n block comes to.
const blockPenaltyOf = (modules: Uint8Array, size: number): number => {
  let blocks = 0
  for (let row = 0; row + 1 < size; row += 1) {
    for (let column = 0; column + 1 < size; column += 1) {
      const index = row * size + column
      const color = modules[index]
      const oneColor =
        modules[index + 1] === color && modules[index + size] === color && modules[index + size + 1] === color
      blocks += oneColor ? 1 : 0
    }
  }
  return 3 * blocks
}

// Rule 4: 10 for each step of 5% the share of dark modules lies outside 45% to 55%: 0 within it, 10
// from 40% to 45% or 55% to 60%, and so on. The symbol has an odd number of modules, so its share is
// never exactly on a step.
const balancePenaltyOf = (modules: Uint8Array): number => {
  let dark = 0
  for (const module of modules) {
    dark += module
  }
  const total = modules.length
  return 10 * (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1)
}

/**
 * The penalty of a masked symbol, `size` by `size` modules row by row, 1 for a dark one, by the
 * standard's four rules: long runs, 2 by 2 blocks, finder-like patterns, and an unbalanced share of
 * dark modules. The mask whose symbol scores lowest is the one used.
 */
export const maskPenaltyOf = (modules: Uint8Array, size: number): number => {
  let penalty = blockPenaltyOf(modules, size) + balancePenaltyOf(modules)
  for (let line = 0; line < size; line += 1) {
    penalty += linePenaltyOf(modules, line * size, 1, size) + linePenaltyOf(modules, line, size, size)
  }
  return penalty
}
