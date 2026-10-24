/**
 * Encodes text as a QR code (ISO/IEC 18004), such as a link a phone's camera opens, and draws it as
 * SVG path data. Byte mode at error correction level M, versions 1 to 40: up to 2331 bytes of UTF-8.
 */
export type { QrCode } from "./qr-code.ts"
export { encodeQrCode } from "./qr-code.ts"
export { qrCodePath } from "./qr-code-path.ts"
export { QrCodeTooLong } from "./qr-code-too-long.ts"
