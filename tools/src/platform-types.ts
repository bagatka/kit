/**
 * A type a package takes one of the platform's objects as, such as `JwtCrypto` for `crypto.subtle`.
 * Packages declare these structurally, so they compile without the platform's types; the object
 * itself must still fit, as each platform types it.
 */
export interface PlatformType {
  readonly packageName: string
  /** The type's name, as the package exports it. */
  readonly type: string
  /**
   * The platform's object, as a host passes it: a global every platform has, `crypto.subtle`; or the
   * type of a Cloudflare binding, `Ai` for `env.AI`, which only Workers have.
   */
  readonly object: "crypto" | "crypto.subtle" | { readonly workersBinding: "Ai" }
}

/**
 * Every package's platform types. The check that packages install builds a program that passes
 * each object to each type, and type-checks it once with the DOM's types (browsers, Deno, Bun and
 * Node follow them) and once with Cloudflare Workers'. A package that takes a platform object lists
 * it here (PATTERNS.md, "The platform").
 */
export const platformTypes: ReadonlyArray<PlatformType> = [
  { packageName: "@bagatka/apns", type: "ApnsCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/app-store-connect", type: "AppStoreConnectCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/github-app", type: "GitHubAppCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/github-app", type: "WebhookCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/jwt", type: "JwtCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/webauthn", type: "AuthenticatorCrypto", object: "crypto" },
  { packageName: "@bagatka/webauthn", type: "WebAuthnCrypto", object: "crypto.subtle" },
  { packageName: "@bagatka/ai-cloudflare-binding", type: "WorkersAiBinding", object: { workersBinding: "Ai" } },
]

/**
 * A program that passes each platform object to the types that take it, for a type checker: the
 * globals every platform has, or with `workersBindings`, the bindings only Workers have. It names a
 * global itself, `crypto`, as programs do: Workers declare it a constant, which isn't a property of
 * `globalThis`.
 */
export const platformProgram = (types: ReadonlyArray<PlatformType>, workersBindings: boolean): string =>
  types
    .map(({ packageName, type, object }, index) => {
      const imported = `import type { ${type} as Type${index} } from "${packageName}"\n`
      if (typeof object === "string") {
        return workersBindings ? "" : `${imported}export const fits${index}: Type${index} = ${object}\n`
      }
      return workersBindings
        ? `${imported}declare const binding${index}: ${object.workersBinding}\nexport const fits${index}: Type${index} = binding${index}\n`
        : ""
    })
    .join("")
