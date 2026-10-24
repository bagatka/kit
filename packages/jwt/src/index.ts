/**
 * Signs JSON Web Tokens with ES256 or RS256 keys, such as Apple's `.p8` keys and a GitHub App's,
 * through the platform's Web Crypto: import a key once, then sign a header and claims into a
 * compact JWS as often as needed.
 */
export { signJwt } from "./sign-jwt.ts"
export type { JwtCrypto, SigningKey } from "./signing-key.ts"
export { importSigningKey, InvalidSigningKey, JwtAlgorithm } from "./signing-key.ts"
