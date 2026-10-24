// The forty versions of a QR code at error correction level M (ISO/IEC 18004:2015).

/** A version at level M, and what it holds. */
export interface Version {
  readonly number: number
  /** Modules on each side: 21 at version 1, and 4 more for each version. */
  readonly size: number
  /** The bits of byte mode's character count: 8 up to version 9, 16 from version 10. */
  readonly countBits: number
  readonly blockCount: number
  readonly correctionPerBlock: number
  /** Every codeword the symbol holds, data and error correction. */
  readonly codewords: number
  readonly dataCodewords: number
  /** The bytes of text it holds in byte mode: its data bits, less the mode indicator and the count. */
  readonly byteCapacity: number
  /** The rows and columns its alignment patterns are centered on. */
  readonly alignmentCenters: ReadonlyArray<number>
}

// Level M at each version: the error correction codewords of each block and how many blocks there
// are (Table 9), and the alignment patterns' centers (Annex E).
const levelM: ReadonlyArray<readonly [correctionPerBlock: number, blocks: number, centers: ReadonlyArray<number>]> = [
  [10, 1, []],
  [16, 1, [6, 18]],
  [26, 1, [6, 22]],
  [18, 2, [6, 26]],
  [24, 2, [6, 30]],
  [16, 4, [6, 34]],
  [18, 4, [6, 22, 38]],
  [22, 4, [6, 24, 42]],
  [22, 5, [6, 26, 46]],
  [26, 5, [6, 28, 50]],
  [30, 5, [6, 30, 54]],
  [22, 8, [6, 32, 58]],
  [22, 9, [6, 34, 62]],
  [24, 9, [6, 26, 46, 66]],
  [24, 10, [6, 26, 48, 70]],
  [28, 10, [6, 26, 50, 74]],
  [28, 11, [6, 30, 54, 78]],
  [26, 13, [6, 30, 56, 82]],
  [26, 14, [6, 30, 58, 86]],
  [26, 16, [6, 34, 62, 90]],
  [26, 17, [6, 28, 50, 72, 94]],
  [28, 17, [6, 26, 50, 74, 98]],
  [28, 18, [6, 30, 54, 78, 102]],
  [28, 20, [6, 28, 54, 80, 106]],
  [28, 21, [6, 32, 58, 84, 110]],
  [28, 23, [6, 30, 58, 86, 114]],
  [28, 25, [6, 34, 62, 90, 118]],
  [28, 26, [6, 26, 50, 74, 98, 122]],
  [28, 28, [6, 30, 54, 78, 102, 126]],
  [28, 29, [6, 26, 52, 78, 104, 130]],
  [28, 31, [6, 30, 56, 82, 108, 134]],
  [28, 33, [6, 34, 60, 86, 112, 138]],
  [28, 35, [6, 30, 58, 86, 114, 142]],
  [28, 37, [6, 34, 62, 90, 118, 146]],
  [28, 38, [6, 30, 54, 78, 102, 126, 150]],
  [28, 40, [6, 24, 50, 76, 102, 128, 154]],
  [28, 43, [6, 28, 54, 80, 106, 132, 158]],
  [28, 45, [6, 32, 58, 84, 110, 136, 162]],
  [28, 47, [6, 26, 54, 82, 110, 138, 166]],
  [28, 49, [6, 30, 58, 86, 114, 142, 170]],
]

// The modules data takes, 8 to a codeword, with the rest left as remainder bits: all of them, less
// the three finders with their separators (64 modules each), the format information and the dark
// module (31), the two timing patterns between the finders, every alignment pattern (25 modules,
// of which 5 lie on a timing pattern for each one on row or column 6), and from version 7 the two
// blocks of version information (36).
const codewordsOf = (size: number, centers: number, hasVersionInformation: boolean): number => {
  const alignments = centers === 0 ? 0 : centers * centers - 3
  const onTiming = centers === 0 ? 0 : 2 * (centers - 2)
  const functionModules =
    3 * 64 + 31 + 2 * (size - 16) + 25 * alignments - 5 * onTiming + (hasVersionInformation ? 36 : 0)
  return Math.floor((size * size - functionModules) / 8)
}

/** Versions 1 to 40, in order. */
export const versions: ReadonlyArray<Version> = levelM.map(
  ([correctionPerBlock, blockCount, alignmentCenters], index) => {
    const number = index + 1
    const size = 17 + 4 * number
    const countBits = number < 10 ? 8 : 16
    const codewords = codewordsOf(size, alignmentCenters.length, number >= 7)
    const dataCodewords = codewords - correctionPerBlock * blockCount
    const byteCapacity = Math.floor((dataCodewords * 8 - 4 - countBits) / 8)
    return {
      number,
      size,
      countBits,
      blockCount,
      correctionPerBlock,
      codewords,
      dataCodewords,
      byteCapacity,
      alignmentCenters,
    }
  },
)
