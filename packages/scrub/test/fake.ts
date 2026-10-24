/**
 * A made-up secret as the tests write it, with a `·` inside its provider's prefix (`gh·p_`,
 * `xox·b-`, `PRIV·ATE KEY`), so secret scanners don't take the tests' fakes for real keys; and
 * without the `·`, as the tests use it. No case holds a `·` of its own.
 */
export const fake = (text: string): string => text.replaceAll("·", "")
