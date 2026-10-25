/**
 * A type a package shares with the platform: one it takes a platform object as, such as `JwtCrypto`
 * for `crypto.subtle`, or one whose values the platform's own types also describe, such as WebAuthn's
 * JSON. Packages declare these themselves, so they compile without the platform's types; they must
 * still fit the platform's, as each platform types them.
 */
export interface PlatformType {
  readonly packageName: string
  /** The type's name, as the package exports it. */
  readonly type: string
  /**
   * What it must fit. The platform's object, as a host passes it: a global every platform has,
   * `crypto.subtle`; or the type of a Cloudflare binding, `Ai` for `env.AI`, which only Workers have.
   * Or a type of the DOM's: `toDom`, when the package's values go to the DOM's API as that type;
   * `fromDom`, when the DOM's values of that type come to the package.
   */
  readonly object:
    | "crypto"
    | "crypto.subtle"
    | { readonly workersBinding: "Ai" }
    | { readonly toDom: string }
    | { readonly fromDom: string }
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
  {
    packageName: "@bagatka/webauthn",
    type: "PublicKeyCredentialCreationOptionsJSON",
    object: { toDom: "PublicKeyCredentialCreationOptionsJSON" },
  },
  {
    packageName: "@bagatka/webauthn",
    type: "PublicKeyCredentialRequestOptionsJSON",
    object: { toDom: "PublicKeyCredentialRequestOptionsJSON" },
  },
  {
    packageName: "@bagatka/webauthn",
    type: "RegistrationResponseJSON",
    object: { fromDom: "RegistrationResponseJSON" },
  },
  {
    packageName: "@bagatka/webauthn",
    type: "AuthenticationResponseJSON",
    object: { fromDom: "AuthenticationResponseJSON" },
  },
  { packageName: "@bagatka/ai-cloudflare-binding", type: "WorkersAiBinding", object: { workersBinding: "Ai" } },
]

/**
 * A program that passes each platform object to the types that take it, for a type checker, from
 * one part of the platform: the globals every platform has; the bindings only Workers have; or the
 * DOM's types, which only the DOM's library declares. It names a global itself, `crypto`, as
 * programs do: Workers declare it a constant, which isn't a property of `globalThis`.
 */
export const platformProgram = (
  types: ReadonlyArray<PlatformType>,
  part: "globals" | "workersBindings" | "domTypes",
): string =>
  types
    .map(({ packageName, type, object }, index) => {
      const imported = `import type { ${type} as Type${index} } from "${packageName}"\n`
      if (typeof object === "string") {
        return part === "globals" ? `${imported}export const fits${index}: Type${index} = ${object}\n` : ""
      }
      if ("workersBinding" in object) {
        return part === "workersBindings"
          ? `${imported}declare const binding${index}: ${object.workersBinding}\nexport const fits${index}: Type${index} = binding${index}\n`
          : ""
      }
      if (part !== "domTypes") {
        return ""
      }
      return "toDom" in object
        ? `${imported}declare const value${index}: Type${index}\nexport const fits${index}: ${object.toDom} = value${index}\n`
        : `${imported}declare const value${index}: ${object.fromDom}\nexport const fits${index}: Type${index} = value${index}\n`
    })
    .join("")
