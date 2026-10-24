import type { PackageRule } from "@bagatka/workspace-rules"

// Effect's Crypto on Web Crypto, which tests provide as Workers and browsers do.
const forTests = ["@effect/platform-browser", "@effect/vitest", "vitest"]

/**
 * Which packages may depend on which: the table in ARCHITECTURE.md, "Dependency rules", as data.
 * A change here is an architecture change, and updates that table in the same change.
 */
export const workspaceRules: ReadonlyArray<PackageRule> = [
  // Runs @effect/ai-cloudflare's decisions through a Worker's AI binding, providing its client.
  {
    folders: "packages/ai-cloudflare-binding",
    name: "@bagatka/*",
    contract: true,
    mayUse: ["packages/*"],
    mayInstall: ["effect", "@effect/ai-cloudflare"],
    mayInstallForDevelopment: forTests,
  },
  {
    folders: "packages/*",
    name: "@bagatka/*",
    contract: true,
    mayUse: ["packages/*"],
    mayInstall: ["effect"],
    mayInstallForDevelopment: forTests,
  },
  {
    folders: "tools",
    name: "kit-tools",
    contract: false,
    mayUse: ["packages/*"],
    mayInstall: ["effect", "@effect/platform-bun"],
    // Cloudflare Workers' types, which the check that packages install type-checks them against.
    mayInstallForDevelopment: ["@cloudflare/workers-types", ...forTests],
  },
]
