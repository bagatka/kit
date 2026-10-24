import type { QrCode } from "./qr-code.ts"

const isDarkAt = (code: QrCode, row: number, column: number): boolean =>
  column >= 0 && column < code.size && code.modules[row * code.size + column] === true

// Whether `code` has a QR code's shape: a version's size, 17 and a multiple of 4 from 21 to 177, so
// a whole number, and a module for each of its squares.
const isQrCode = (code: QrCode): boolean =>
  code.size >= 21 && code.size <= 177 && (code.size - 17) % 4 === 0 && code.modules.length === code.size * code.size

/**
 * SVG path data that draws `code` in a `0 0 size size` view box: each run of dark modules along a
 * row is one rectangle, 1 high, so the path stays short and adjacent modules show no seams. Leave
 * the 4-module quiet zone readers need around it:
 * `<svg viewBox="-4 -4 {size + 8} {size + 8}"><path d={qrCodePath(code)} /></svg>`. Empty for a code
 * that hasn't a QR code's shape, which `encodeQrCode` never makes.
 */
export const qrCodePath = (code: QrCode): string => {
  if (!isQrCode(code)) {
    return ""
  }
  const rectangles: Array<string> = []
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      const startsRun = isDarkAt(code, row, column) && !isDarkAt(code, row, column - 1)
      if (startsRun) {
        let end = column + 1
        while (isDarkAt(code, row, end)) {
          end += 1
        }
        rectangles.push(`M${column} ${row}h${end - column}v1h-${end - column}z`)
      }
    }
  }
  return rectangles.join("")
}
