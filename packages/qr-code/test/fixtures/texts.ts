// The texts the tests encode, made by a fixed generator or found by a search, as the program that
// captured another encoder's codes for them reads them (capture-reference.py).

/** The bytes level M holds in byte mode at versions 1 to 40 (ISO/IEC 18004:2015, Table 7). */
export const capacities: ReadonlyArray<number> = [
  14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666, 711, 779, 857, 911,
  997, 1059, 1125, 1190, 1264, 1370, 1452, 1538, 1628, 1722, 1809, 1911, 1989, 2099, 2213, 2331,
]

// Lowercase letters, which only byte mode holds, so every encoder writes them in byte mode.
const lettersFrom = (seed: number) => {
  let state = seed
  return (length: number): string =>
    Array.from({ length }, () => {
      state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
      return String.fromCharCode(0x61 + ((state >>> 8) % 26))
    }).join("")
}

/** For each version, as many letters as it holds, so each text fills its version. */
export const fullTexts: ReadonlyArray<string> = capacities.map(lettersFrom(2026))

/**
 * Links whose codes take each of the 8 masks, and links on which one detail of the penalty rules
 * decides the mask: with that detail read otherwise, another mask scores lowest. Found by
 * searching links for each.
 */
export const maskTexts: ReadonlyArray<string> = [
  "https://notes.example/pair?code=1swR8", // Mask 0.
  "https://notes.example/pair?code=E8", // Mask 1.
  "https://notes.example/n/Cl", // Mask 2.
  "https://notes.example/pair?code=up1MAeMd5ql", // Mask 3.
  "https://notes.example/n/7ha1pCgnq6duN9xjm0jog2NclzyB", // Mask 4.
  // Mask 5, by a finder-like pattern at the symbol's edge, whose light area is the quiet zone.
  "https://notes.example/n/artNBmLuNQGYwVNloGTTy3wR96Mnuvc",
  "https://notes.example/n/Ckh0yf7quXyPbmgZRmHXBD7sjTvmfgQ", // Mask 6.
  "https://notes.example/pair?code=ouG", // Mask 7.
  "https://notes.example/n/KZltxN", // By a run of exactly 5 modules.
  "https://notes.example/n/I5HOGGxXEsgPwzRNrUQLuL0f5V0TFmQf", // By 2 by 2 blocks of one color.
  "https://notes.example/pair?code=rpJUt", // By a finder-like pattern with light on both sides, counted twice.
  "https://notes.example/n/rBlnm4", // By a finder-like pattern 2 modules to its unit.
  // By one 2 modules to its unit with less light than a unit on one side, which isn't counted.
  "https://notes.example/n/NiTIZ6pingvI5cf6dCj49wB0t07SRmFu5otO1UPi72VGJ6lcJY9GJwHGVK1ejwRyz8j8HyLqhCL2X8HiX0bKbMr",
  "https://notes.example/pair?code=uGIAyn8Offk2lwaJoEftbB9", // By the share of dark modules.
  "https://notes.example/pair?code=Sxk", // By a tie, which the lower mask wins.
]
