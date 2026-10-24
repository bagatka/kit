# @bagatka/qr-code

Encodes text as a QR code, such as a link a phone's camera opens, and draws it as SVG path data,
with Effect.

## Install

```sh
npm install @bagatka/qr-code effect
```

Its peer dependency is `effect`, at the minor version it is built with: your program uses that one
too. It is plain JavaScript and needs nothing from the platform, so it runs everywhere: Cloudflare
Workers, browsers, Deno, Bun, and Node.

## Use it

```ts
import { encodeQrCode, qrCodePath } from "@bagatka/qr-code"
import { Result } from "effect"

const encoded = encodeQrCode("https://notes.example/pair?code=Zk3Pq9TzX2mV8wYb4LdR7nHs1cFgJ0uE")
if (Result.isSuccess(encoded)) {
  const code = encoded.success
  // Dark on light, with 4 light modules around the code: the quiet zone readers need.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-4 -4 ${code.size + 8} ${code.size + 8}"
    shape-rendering="crispEdges"><rect x="-4" y="-4" width="100%" height="100%" fill="white" />
    <path d="${qrCodePath(code)}" fill="black" /></svg>`
} else {
  encoded.failure // QrCodeTooLong { byteLength: 2412, limit: 2331 }: encode a short link to it instead.
}
```

## Contract

`src/index.ts`. Callers turn text into a code, which is plain data, a square of dark and light
modules (the standard's word for its squares), and draw it with `qrCodePath`, or any other way, such
as on a canvas. The same text always gives the same code.

## Does not own

- **What the text says.** Links, Wi-Fi configurations (`WIFI:T:WPA;S:<network>;P:<password>;;`),
  vCards and one-time password links (`otpauth://`) are text the caller writes.
- **Drawing beyond the path.** Size, colors, and the quiet zone are the caller's. A logo over the
  code isn't supported: level M survives about 15% of the code being unreadable, and a logo needs
  more.
- **Reading QR codes.**

## Depends on

`effect`, for `Result` and the error's Schema. Nothing from the platform.

## Decisions and constraints

- **Doesn't trust the text.** A code may hold whatever a person typed or a link carries: any text is
  encoded, or refused as too long, in time linear in its length. **Trusts its caller.**
- **One kind of code: byte mode at level M,** in the smallest of versions 1 to 40 that holds the
  text: up to 2331 bytes of UTF-8, and from 21 to 177 modules a side. Level M survives about 15% of
  the code being unreadable, and is what most generators make. Not supported: the numeric,
  alphanumeric and kanji modes, which pack digits or capitals tighter, mixing modes in one code,
  other levels, ECI, Micro QR, and structured append. A text of digits or capitals makes a code a
  little larger than it could be, which reads the same.
- **The standard's mask, checked against another encoder.** All eight masks are scored by the
  standard's four penalty rules (ISO/IEC 18004:2015, 7.8.3), and the lowest wins, the lower number
  on a tie. Rule 3 is read as the standard words it: dark, light, dark, light and dark runs in the
  ratio 1:1:3:1:1, of any width, with a light area 4 widths wide before or after them, each side
  counted, the quiet zone included. It is the reading of Project Nayuki's qrcodegen, which is
  written from the standard independently of this one: its codes and these are the same, module for
  module, for 5,325 texts compared, and zxing-cpp, a decoder of its own, read each of them back.
  Tests hold qrcodegen's code at every version and for every mask, and for each detail of the rules
  that decides one; `test/fixtures/capture-reference.py` captures them with `uv run`, on any machine.
  uv isn't in `./dev`'s shell: install it as https://docs.astral.sh/uv/getting-started/installation/
  says, and it fetches the Python and the packages the program names.
- **UTF-8 without an ECI header,** as most encoders write it and phones' cameras read it. A lone
  surrogate, which UTF-8 can't hold, is encoded as U+FFFD, as `TextEncoder` does.
- **Rows of rectangles:** `qrCodePath` draws each run of dark modules along a row as one rectangle,
  which keeps the path short and leaves no seams between adjacent modules. A code that hasn't a QR
  code's shape, a version's size and a module for each square, which `encodeQrCode` never makes,
  draws nothing, however large it says it is.
- **Dark on light.** Readers need the contrast: keep the code dark on a light background, with its
  quiet zone, in a dark theme too. Not every reader reads a code drawn light on dark.
- **Cost:** a link takes about 0.3 ms and version 40 about 9 ms (Node and Bun on an M-series Mac).
  Text over the limit is refused after encoding it once as UTF-8, in time linear in its length.
