import { assert, describe, it } from "@effect/vitest"
import { Result } from "effect"

import { publishedManifest } from "../src/published-manifest.ts"

const context = {
  folder: "packages/apns",
  packageVersions: new Map([
    ["@bagatka/jwt", "0.3.1"],
    ["@bagatka/apns", "0.2.0"],
  ]),
  catalog: { effect: "4.0.5", "@effect/vitest": "4.0.5" },
}

const described = { description: "Sends pushes to Apple devices through APNs.", keywords: ["apns", "push"] }

describe("publishedManifest", () => {
  it("gives packages and the catalog's packages exact versions, with effect as a peer at its minor", () => {
    const published = publishedManifest(
      {
        name: "@bagatka/apns",
        version: "0.2.0",
        ...described,
        sideEffects: false,
        dependencies: { "@bagatka/jwt": "workspace:*", effect: "catalog:" },
      },
      context,
    )
    assert.deepStrictEqual(
      published,
      Result.succeed({
        name: "@bagatka/apns",
        version: "0.2.0",
        description: "Sends pushes to Apple devices through APNs.",
        keywords: ["apns", "push"],
        license: "MIT",
        author: "Aleksandr Bagatka",
        homepage: "https://github.com/bagatka/kit/tree/main/packages/apns#readme",
        bugs: "https://github.com/bagatka/kit/issues",
        repository: { type: "git", url: "git+https://github.com/bagatka/kit.git", directory: "packages/apns" },
        type: "module",
        sideEffects: false,
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
        dependencies: { "@bagatka/jwt": "0.3.1" },
        peerDependencies: { effect: "~4.0.5" },
      }),
    )
  })

  it("leaves out dependencies a package doesn't have", () => {
    const published = publishedManifest({ name: "@bagatka/scrub", version: "0.1.0", ...described }, context)
    assert.isTrue(Result.isSuccess(published))
    if (Result.isSuccess(published)) {
      assert.isFalse("dependencies" in published.success)
      assert.isFalse("peerDependencies" in published.success)
      assert.isFalse("sideEffects" in published.success)
    }
  })

  it("refuses a package without a version, description or keywords, or with a version npm wouldn't take as latest", () => {
    const missing = publishedManifest({ name: "@bagatka/apns" }, context)
    const prerelease = publishedManifest({ name: "@bagatka/apns", version: "0.2.0-beta.1", ...described }, context)
    assert.deepStrictEqual(
      missing,
      Result.fail([
        `Has no version. Give it one: "0.1.0" before its first publish (PATTERNS.md, "Versions").`,
        "Has no description, which npm shows and searches. Give the README's first sentence.",
        "Has no keywords, which npm searches. Give the words people search for it by.",
      ]),
    )
    assert.deepStrictEqual(
      prerelease,
      Result.fail([`Has version "0.2.0-beta.1". Give one MAJOR.MINOR.PATCH, such as "0.1.0".`]),
    )
  })

  it("refuses dependencies npm can't have, naming each", () => {
    const published = publishedManifest(
      {
        name: "@bagatka/apns",
        version: "0.2.0",
        ...described,
        dependencies: { "@bagatka/unversioned": "workspace:*", "left-pad": "catalog:", effect: "^4.0.0" },
      },
      context,
    )
    assert.deepStrictEqual(
      published,
      Result.fail([
        "Depends on @bagatka/unversioned, which isn't a package with a version, so npm can't have it.",
        "Depends on left-pad from the catalog, which has no version of it.",
        `Depends on effect as "^4.0.0". Give "workspace:*" or "catalog:", which have exact versions.`,
      ]),
    )
  })

  it("never resolves a name through Object.prototype", () => {
    const published = publishedManifest(
      { name: "@bagatka/apns", version: "0.2.0", ...described, dependencies: { constructor: "catalog:" } },
      context,
    )
    assert.deepStrictEqual(
      published,
      Result.fail(["Depends on constructor from the catalog, which has no version of it."]),
    )
  })
})
