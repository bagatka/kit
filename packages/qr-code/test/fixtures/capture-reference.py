# /// script
# requires-python = ">=3.10"
# dependencies = ["qrcodegen==1.8.0", "zxing-cpp==3.1.1", "numpy==2.5.4"]
# ///
#
# Captures the codes another encoder makes for the tests' texts (texts.ts), as reference-codes.ts
# holds them: Project Nayuki's qrcodegen, in byte mode at level M, in the smallest version, with its
# own mask choice. Each is read back by zxing-cpp, a decoder of its own, before it is written. On any
# machine with uv, in this folder:
#
#   bun -e 'import { fullTexts, maskTexts } from "./texts.ts"; console.log(JSON.stringify([...fullTexts, ...maskTexts]))' \
#     | uv run capture-reference.py
#
# Each line is the SHA-256 of a code's rows from the top, "1" for a dark module, joined by line
# breaks.

import hashlib
import json
import sys

import numpy
import zxingcpp
from qrcodegen import QrCode, QrSegment


def rows_of(code: QrCode) -> list[str]:
    size = code.get_size()
    return ["".join("1" if code.get_module(x, y) else "0" for x in range(size)) for y in range(size)]


# What zxing-cpp reads from the code drawn 4 pixels a module, with a quiet zone of 4 modules.
def read_back(code: QrCode) -> list[bytes]:
    size, scale = code.get_size(), 4
    side = (size + 8) * scale
    image = numpy.full((side, side), 255, dtype=numpy.uint8)
    for y in range(size):
        for x in range(size):
            if code.get_module(x, y):
                image[(y + 4) * scale : (y + 5) * scale, (x + 4) * scale : (x + 5) * scale] = 0
    return [found.bytes for found in zxingcpp.read_barcodes(image, formats=zxingcpp.BarcodeFormat.QRCode)]


for text in json.load(sys.stdin):
    data = text.encode("utf-8")
    code = QrCode.encode_segments([QrSegment.make_bytes(data)], QrCode.Ecc.MEDIUM, boostecl=False)
    if read_back(code) != [data]:
        sys.exit(f"zxing-cpp didn't read back {text[:20]!r}")
    digest = hashlib.sha256("\n".join(rows_of(code)).encode()).hexdigest()
    print(f'  "{digest}",')
