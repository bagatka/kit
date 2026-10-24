/**
 * Removes credentials and personal data from text before it is stored: tokens, keys, secrets in
 * URLs, emails, and card numbers.
 */
export { isSecretName, scrubText } from "./scrub-text.ts"
