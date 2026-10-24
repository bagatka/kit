import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto"
import { assert, describe, it } from "@effect/vitest"
import { Crypto, Effect, Result } from "effect"
import { Hex } from "effect/encoding"

import type { QrCode } from "../src/index.ts"
import { encodeQrCode, qrCodePath } from "../src/index.ts"
import { fullTextCodes, maskTextCodes } from "./fixtures/reference-codes.ts"
import { capacities, fullTexts, maskTexts } from "./fixtures/texts.ts"

// The runtime's clock and text encoder, which tests outside a runtime with its types can't name.
declare const performance: { readonly now: () => number }
declare const TextEncoder: new () => { readonly encode: (input: string) => Uint8Array<ArrayBuffer> }

const encoded = (text: string): QrCode =>
  Result.match(encodeQrCode(text), {
    onSuccess: (code) => code,
    onFailure: (error) => assert.fail(error.message),
  })

// The SHA-256 of the code's rows from the top, "1" for a dark module, joined by line breaks, as the
// fixtures hold the reference encoder's codes.
const digestOf = Effect.fn("digestOf")(function* (code: QrCode) {
  const rows = Array.from({ length: code.size }, (_, row) =>
    code.modules
      .slice(row * code.size, (row + 1) * code.size)
      .map((isDark) => (isDark ? "1" : "0"))
      .join(""),
  )
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(rows.join("\n")))
  return Hex.encode(digest)
})

describe("encodeQrCode", () => {
  it("chooses the smallest of the 40 versions that holds the text, from 21 to 177 modules a side", () => {
    for (const [index, capacity] of capacities.entries()) {
      const size = 21 + 4 * index
      const full = encoded("a".repeat(capacity))
      assert.strictEqual(full.size, size, `${capacity} bytes`)
      assert.strictEqual(full.modules.length, size * size)
      if (index < capacities.length - 1) {
        assert.strictEqual(encoded("a".repeat(capacity + 1)).size, size + 4, `${capacity + 1} bytes`)
      }
    }
  })

  it.effect("makes the code qrcodegen makes, module for module, at every version", () =>
    Effect.gen(function* () {
      for (const [index, text] of fullTexts.entries()) {
        assert.strictEqual(yield* digestOf(encoded(text)), fullTextCodes[index], `version ${index + 1}`)
      }
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  )

  it.effect("chooses each mask as qrcodegen does, where one detail of a penalty rule decides", () =>
    Effect.gen(function* () {
      for (const [index, text] of maskTexts.entries()) {
        assert.strictEqual(yield* digestOf(encoded(text)), maskTextCodes[index], text)
      }
    }).pipe(Effect.provide(BrowserCrypto.layer)),
  )

  it("refuses more than 2331 bytes of UTF-8 with QrCodeTooLong, counting bytes, not characters", () => {
    // "é" takes 2 bytes, "😀" 4 though it is 2 characters of a JavaScript string, and a lone
    // surrogate 3, as the U+FFFD that UTF-8 holds in its place.
    for (const text of ["a".repeat(2332), "é".repeat(1166), "😀".repeat(583), "\ud800".repeat(778)]) {
      const refused = encodeQrCode(text)
      assert.isTrue(Result.isFailure(refused))
      if (Result.isFailure(refused)) {
        assert.strictEqual(refused.failure._tag, "QrCodeTooLong")
        assert.strictEqual(refused.failure.byteLength, text === "\ud800".repeat(778) ? 2334 : 2332)
        assert.strictEqual(refused.failure.limit, 2331)
        // What a log shows: both numbers.
        assert.include(refused.failure.message, `${refused.failure.byteLength} bytes`)
        assert.include(refused.failure.message, "2331")
      }
    }
  })

  it("takes time linear in the text's length: version 40 is made, and 10 MB refused, within bounds", () => {
    const largest = performance.now()
    assert.strictEqual(encoded("a".repeat(2331)).size, 177)
    assert.isBelow(performance.now() - largest, 250)
    const huge = performance.now()
    assert.isTrue(Result.isFailure(encodeQrCode("a".repeat(10_000_000))))
    assert.isBelow(performance.now() - huge, 1_000)
  })
})

describe("qrCodePath", () => {
  const code = encoded("https://notes.example/pair?code=Zk3Pq9TzX2mV8wYb4LdR7nHs1cFgJ0uE")
  const rectangle = /M(\d+) (\d+)h(\d+)v1h-\3z/g
  const rectanglesOf = (path: string) =>
    [...path.matchAll(rectangle)].map((match) => ({
      column: Number(match[1]),
      row: Number(match[2]),
      width: Number(match[3]),
    }))

  it("draws every dark module once, and no light one, from version 1 to 40", () => {
    for (const drawn of [encoded("a".repeat(14)), code, encoded("a".repeat(2331))]) {
      const covered = drawn.modules.map(() => 0)
      for (const { column, row, width } of rectanglesOf(qrCodePath(drawn))) {
        for (let offset = 0; offset < width; offset += 1) {
          const index = row * drawn.size + column + offset
          covered[index] = (covered[index] ?? 0) + 1
        }
      }
      assert.deepStrictEqual(
        covered,
        drawn.modules.map((isDark) => Number(isDark)),
        `${drawn.size} modules`,
      )
    }
  })

  it("draws nothing for a code that hasn't a QR code's shape, however large it says it is", () => {
    // Sizes of no version, with a module for each square: below version 1, between 1 and 2, past 40.
    for (const size of [17, 22, 181]) {
      assert.strictEqual(qrCodePath({ size, modules: Array.from({ length: size * size }, () => true) }), "", `${size}`)
    }
    for (const size of [1_000_000, Number.POSITIVE_INFINITY]) {
      assert.strictEqual(qrCodePath({ size, modules: [] }), "")
    }
    assert.strictEqual(qrCodePath({ size: code.size, modules: code.modules.slice(1) }), "")
  })

  it("draws each run of dark modules along a row as one rectangle, and nothing else", () => {
    const path = qrCodePath(code)
    const runs = code.modules.filter(
      (isDark, index) => isDark && (index % code.size === 0 || code.modules[index - 1] === false),
    )
    assert.strictEqual(path.replaceAll(rectangle, ""), "")
    assert.strictEqual(rectanglesOf(path).length, runs.length)
    // The top row begins with the top-left finder's 7 dark modules, then its light separator.
    assert.isTrue(path.startsWith("M0 0h7v1h-7zM"), path.slice(0, 40))
  })
})
