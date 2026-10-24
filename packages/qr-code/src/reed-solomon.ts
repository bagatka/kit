// Reed-Solomon error correction as QR codes use it (ISO/IEC 18004:2015, 7.5.2): codewords are
// elements of GF(256) with the field polynomial x^8 + x^4 + x^3 + x^2 + 1, and the generator
// polynomial of degree n has the roots α^0 to α^(n-1), where α is 2.

const fieldPolynomial = 0x11d

// The product of two field elements: shift and add, reducing by the field polynomial on each shift.
const multiply = (left: number, right: number): number => {
  let product = 0
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * fieldPolynomial)
    product ^= ((right >>> bit) & 1) * left
  }
  return product
}

/**
 * The generator polynomial of `degree`, its coefficients from x^(degree-1) down to x^0; the leading
 * coefficient, 1, is left out. Built as the product of (x - α^i) for i from 0 to degree - 1.
 */
export const generatorOf = (degree: number): Uint8Array => {
  const coefficients = new Uint8Array(degree)
  coefficients[degree - 1] = 1
  let root = 1
  for (let factor = 0; factor < degree; factor += 1) {
    for (let index = 0; index < degree; index += 1) {
      // Reads the next coefficient before it is updated; past the end, the coefficient is 0.
      coefficients[index] = multiply(coefficients[index] ?? 0, root) ^ (coefficients[index + 1] ?? 0)
    }
    root = multiply(root, 2)
  }
  return coefficients
}

/** The error correction codewords of a block of data codewords, for `generator` of their number. */
export const errorCorrectionOf = (data: Uint8Array, generator: Uint8Array): Uint8Array => {
  // The remainder of the data polynomial times x^degree, divided by the generator.
  const remainder = new Uint8Array(generator.length)
  for (const codeword of data) {
    const factor = codeword ^ (remainder[0] ?? 0)
    for (const [index, coefficient] of generator.entries()) {
      // Shifts the remainder by one as it goes; past the end, the coefficient is 0.
      remainder[index] = (remainder[index + 1] ?? 0) ^ multiply(coefficient, factor)
    }
  }
  return remainder
}
