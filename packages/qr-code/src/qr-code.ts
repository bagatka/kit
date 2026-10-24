import { Result } from "effect"

import { maskPenaltyOf } from "./mask-penalty.ts"
import { QrCodeTooLong } from "./qr-code-too-long.ts"
import { errorCorrectionOf, generatorOf } from "./reed-solomon.ts"
import type { Version } from "./versions.ts"
import { versions } from "./versions.ts"

/**
 * A QR code as plain data: `size` by `size` modules, the standard's word for its squares. Holds no
 * quiet zone; whoever draws it leaves 4 light modules on every side.
 */
export interface QrCode {
  /** Modules on each side: 21 at version 1, and 4 more for each version, up to 177 at version 40. */
  readonly size: number
  /** `size * size` modules, row by row from the top left, `true` for a dark one. */
  readonly modules: ReadonlyArray<boolean>
}

const byteMode = 0b0100

const byteLimit = Math.max(...versions.map((version) => version.byteCapacity))

// The data codewords (7.4): mode, count, the bytes, the terminator's 4 zero bits, then the two pad
// codewords in turn until the version is full. Mode and count take 12 or 20 bits, so all of it is
// whole nibbles, the terminator ends on a byte boundary, and a version that holds the bytes always
// has room for the terminator.
const dataCodewordsOf = (version: Version, bytes: Uint8Array): Uint8Array => {
  const header = (byteMode << version.countBits) | bytes.length
  const headerNibbles = (4 + version.countBits) / 4
  const nibbleAt = (index: number): number => {
    if (index < headerNibbles) {
      return (header >>> (4 * (headerNibbles - 1 - index))) & 0xf
    }
    // Past the bytes, the terminator's nibble: 0.
    const byte = bytes[(index - headerNibbles) >>> 1] ?? 0
    return (index - headerNibbles) % 2 === 0 ? byte >>> 4 : byte & 0xf
  }
  const written = (headerNibbles + 2 * bytes.length + 1) / 2
  const data = new Uint8Array(version.dataCodewords)
  for (let index = 0; index < data.length; index += 1) {
    const padding = (index - written) % 2 === 0 ? 0xec : 0x11
    data[index] = index < written ? (nibbleAt(2 * index) << 4) | nibbleAt(2 * index + 1) : padding
  }
  return data
}

// Every codeword in the order it is placed (7.6): the data split into blocks, the shorter ones
// first, then each block's error correction, each interleaved one codeword from every block in turn.
const codewordsOf = (version: Version, data: Uint8Array): Uint8Array => {
  const { blockCount, correctionPerBlock } = version
  const shortLength = Math.floor(data.length / blockCount)
  const shortBlocks = blockCount - (data.length % blockCount)
  const generator = generatorOf(correctionPerBlock)
  const codewords = new Uint8Array(version.codewords)
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * shortLength + Math.max(0, block - shortBlocks)
    const blockData = data.subarray(start, start + shortLength + (block < shortBlocks ? 0 : 1))
    for (const [index, codeword] of blockData.entries()) {
      // A long block's last codeword comes after every block's others, among the long blocks only.
      const position = index < shortLength ? index * blockCount + block : shortLength * blockCount + block - shortBlocks
      codewords[position] = codeword
    }
    for (const [index, codeword] of errorCorrectionOf(blockData, generator).entries()) {
      codewords[data.length + index * blockCount + block] = codeword
    }
  }
  return codewords
}

// The symbol while it is drawn: which modules are dark, 1, and which belong to function patterns,
// which data never takes and masks never change.
interface Canvas {
  readonly size: number
  readonly dark: Uint8Array
  readonly reserved: Uint8Array
}

const drawFunction = (canvas: Canvas, row: number, column: number, isDark: boolean): void => {
  canvas.dark[row * canvas.size + column] = isDark ? 1 : 0
  canvas.reserved[row * canvas.size + column] = 1
}

// A finder pattern with its top left corner at `top`, `left`, and its light separator around it,
// where that is inside the symbol: rings of 7, 5, and 3 modules, dark, light, and dark.
const drawFinder = (canvas: Canvas, top: number, left: number): void => {
  for (let row = Math.max(0, top - 1); row <= Math.min(canvas.size - 1, top + 7); row += 1) {
    for (let column = Math.max(0, left - 1); column <= Math.min(canvas.size - 1, left + 7); column += 1) {
      const ring = Math.max(Math.abs(row - top - 3), Math.abs(column - left - 3))
      drawFunction(canvas, row, column, ring !== 2 && ring !== 4)
    }
  }
}

// An alignment pattern centered on `centerRow`, `centerColumn`: rings of 5 and 3 modules, dark and light,
// around a dark module.
const drawAlignment = (canvas: Canvas, centerRow: number, centerColumn: number): void => {
  for (let row = centerRow - 2; row <= centerRow + 2; row += 1) {
    for (let column = centerColumn - 2; column <= centerColumn + 2; column += 1) {
      const ring = Math.max(Math.abs(row - centerRow), Math.abs(column - centerColumn))
      drawFunction(canvas, row, column, ring !== 1)
    }
  }
}

// The check bits of a BCH code: `data` times x^degree modulo `generator`, over GF(2).
const bchCheckBits = (data: number, generator: number, degree: number): number => {
  let remainder = data
  for (let step = 0; step < degree; step += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> (degree - 1)) * generator)
  }
  return remainder
}

// The 15 bits of format information for level M, whose 2 bits are 00, and `mask` (7.9.1).
const formatBitsOf = (mask: number): number => ((mask << 10) | bchCheckBits(mask, 0x537, 10)) ^ 0x5412

type Position = readonly [row: number, column: number]

// Where each bit of the format information goes, bit 0 first, in each of its two copies (7.9.1).
// One runs down column 8 beside the top-left finder and back along row 8 under it; the other runs
// along row 8 under the top-right finder from the right edge, then down column 8 beside the
// bottom-left finder to the bottom edge.
const formatPositionsOf = (size: number): ReadonlyArray<ReadonlyArray<Position>> => [
  [
    ...[0, 1, 2, 3, 4, 5, 7, 8].map((row): Position => [row, 8]),
    ...[7, 5, 4, 3, 2, 1, 0].map((column): Position => [8, column]),
  ],
  [
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((fromEnd): Position => [8, size - fromEnd]),
    ...[7, 6, 5, 4, 3, 2, 1].map((fromEnd): Position => [size - fromEnd, 8]),
  ],
]

// The 18 bits of version information, for versions 7 and up (7.10).
const versionBitsOf = (version: Version): number => (version.number << 12) | bchCheckBits(version.number, 0x1f25, 12)

const drawFunctionPatterns = (canvas: Canvas, version: Version): void => {
  const { size } = canvas
  // Timing patterns along row 6 and column 6, dark on even positions; the finders draw over their ends.
  for (let index = 0; index < size; index += 1) {
    drawFunction(canvas, 6, index, index % 2 === 0)
    drawFunction(canvas, index, 6, index % 2 === 0)
  }
  drawFinder(canvas, 0, 0)
  drawFinder(canvas, 0, size - 7)
  drawFinder(canvas, size - 7, 0)
  // An alignment pattern on every pair of centers, except the three corners the finders take.
  const centers = version.alignmentCenters
  const first = centers.at(0)
  const last = centers.at(-1)
  for (const row of centers) {
    for (const column of centers) {
      const onFinder =
        (row === first && column === first) || (row === first && column === last) || (row === last && column === first)
      if (!onFinder) {
        drawAlignment(canvas, row, column)
      }
    }
  }
  // Format information depends on the mask, so it is written with each mask; its modules are
  // reserved here. Beside it, the module that is always dark.
  for (const copy of formatPositionsOf(size)) {
    for (const [row, column] of copy) {
      drawFunction(canvas, row, column, false)
    }
  }
  drawFunction(canvas, size - 8, 8, true)
  // Version information: two blocks of 6 by 3, above the bottom-left finder and left of the top-right one.
  if (version.number >= 7) {
    const bits = versionBitsOf(version)
    for (let bit = 0; bit < 18; bit += 1) {
      const isDark = ((bits >>> bit) & 1) === 1
      const across = Math.floor(bit / 3)
      const along = size - 11 + (bit % 3)
      drawFunction(canvas, along, across, isDark)
      drawFunction(canvas, across, along, isDark)
    }
  }
}

// Places the codewords' bits, the most significant first (7.7.3): from the bottom right, up and
// down two columns at a time, right column first, skipping the vertical timing pattern's column and
// every function module. Modules past the last codeword are the remainder bits, which stay light.
const placeCodewords = (canvas: Canvas, codewords: Uint8Array): void => {
  const { size } = canvas
  const columns = Array.from({ length: size }, (_, index) => size - 1 - index).filter((column) => column !== 6)
  let bit = 0
  for (let pair = 0; pair * 2 < columns.length; pair += 1) {
    const pairColumns = columns.slice(pair * 2, pair * 2 + 2)
    for (let step = 0; step < size; step += 1) {
      const row = pair % 2 === 0 ? size - 1 - step : step
      for (const column of pairColumns) {
        const index = row * size + column
        if (canvas.reserved[index] === 0) {
          canvas.dark[index] = ((codewords[bit >>> 3] ?? 0) >>> (7 - (bit & 7))) & 1
          bit += 1
        }
      }
    }
  }
}

// The eight masks (Table 10): a data module is inverted where its mask's condition holds.
const masks: ReadonlyArray<(row: number, column: number) => boolean> = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (_row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
]

// The finished symbol with mask number `mask`: its data modules masked, its format information written.
const maskedModulesOf = (
  canvas: Canvas,
  mask: number,
  condition: (row: number, column: number) => boolean,
): Uint8Array => {
  const { size } = canvas
  const modules = canvas.dark.map((module, index) => {
    const inverted = canvas.reserved[index] === 0 && condition(Math.floor(index / size), index % size)
    return inverted ? module ^ 1 : module
  })
  const format = formatBitsOf(mask)
  for (const copy of formatPositionsOf(size)) {
    for (const [bit, [row, column]] of copy.entries()) {
      modules[row * size + column] = (format >>> bit) & 1
    }
  }
  return modules
}

// The symbol of `codewords` at `version`, with the mask of the lowest penalty; on a tie, the lowest
// mask number.
const symbolOf = (version: Version, codewords: Uint8Array): QrCode => {
  const { size } = version
  const canvas: Canvas = { size, dark: new Uint8Array(size * size), reserved: new Uint8Array(size * size) }
  drawFunctionPatterns(canvas, version)
  placeCodewords(canvas, codewords)
  // Every penalty is below infinity, so mask 0 replaces the placeholder.
  let chosen = canvas.dark
  let lowest = Number.POSITIVE_INFINITY
  for (const [mask, condition] of masks.entries()) {
    const modules = maskedModulesOf(canvas, mask, condition)
    const penalty = maskPenaltyOf(modules, size)
    if (penalty < lowest) {
      chosen = modules
      lowest = penalty
    }
  }
  return { size, modules: Array.from(chosen, (module) => module === 1) }
}

/**
 * Encodes `text` as a QR code: its UTF-8 bytes in byte mode, at error correction level M, which
 * survives about 15% of the code being unreadable, in the smallest version that holds them, from 1
 * (21 modules a side, 14 bytes) to 40 (177 modules, 2331 bytes). The mask is chosen by the
 * standard's penalty rules (ISO/IEC 18004:2015). Pure, and the same text always gives the same code.
 * Takes about a millisecond for a link, and at most tens of milliseconds at version 40.
 *
 * Fails with `QrCodeTooLong` when the text takes more than 2331 bytes of UTF-8, what version 40
 * holds at level M. No other modes or levels are made.
 */
export const encodeQrCode = (text: string): Result.Result<QrCode, QrCodeTooLong> => {
  const bytes = utf8.encode(text)
  const version = versions.find((candidate) => bytes.length <= candidate.byteCapacity)
  if (version === undefined) {
    return Result.fail(new QrCodeTooLong({ byteLength: bytes.length, limit: byteLimit }))
  }
  return Result.succeed(symbolOf(version, codewordsOf(version, dataCodewordsOf(version, bytes))))
}

// A lone surrogate, which UTF-8 can't hold, becomes U+FFFD, as the encoding standard says.
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }
const utf8 = { encode: (text: string) => new TextEncoder().encode(text) }
