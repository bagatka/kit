import { assert, describe, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit, Layer, Path } from "effect"

import { checkWorkspace } from "../src/index.ts"
import type { PackageRule } from "../src/index.ts"
import { memoryFileSystem } from "./memory-file-system.ts"
import type { MemoryEntry } from "./memory-file-system.ts"

const rules: ReadonlyArray<PackageRule> = [
  {
    folders: "packages/*",
    name: "@acme/*",
    contract: true,
    mayUse: ["packages/*"],
    mayInstall: ["effect"],
    mayInstallForDevelopment: ["vitest"],
  },
  {
    folders: "apps/*",
    name: "@acme/*",
    contract: false,
    mayUse: ["packages/*"],
    mayInstall: ["effect"],
    mayInstallForDevelopment: ["vitest"],
  },
]

const catalog = `"catalog": { "effect": "4.0.5", "vitest": "5.0.5" }`

// The root package.json with `workspaces.packages` set to `patterns`, and `fields` added.
const rootWith = (patterns: ReadonlyArray<string>, fields = "") =>
  `{ "workspaces": { "packages": [${patterns.map((pattern) => `"${pattern}"`).join(", ")}], ${catalog} }${fields} }`

const root = rootWith(["packages/*", "apps/*"])

// A capability with a contract, and an app that uses it: together they follow the rules.
const money = {
  "/repo/packages/money/package.json": `{
    "name": "@acme/money",
    "exports": { ".": "./src/index.ts" },
    "dependencies": { "effect": "catalog:" },
    "devDependencies": { "vitest": "catalog:" }
  }`,
  "/repo/packages/money/src/index.ts": `import { Schema } from "effect"\nexport const Cents = Schema.Int\n`,
}
const shop = {
  "/repo/apps/shop/package.json": `{
    "name": "@acme/shop",
    "dependencies": { "@acme/money": "workspace:*", "effect": "catalog:" }
  }`,
}

// A package in packages/ that follows the rules and depends on `dependencies`, each "workspace:*".
const capability = (name: string, dependencies: ReadonlyArray<string>) => ({
  [`/repo/packages/${name}/package.json`]: `{ "name": "@acme/${name}", "exports": { ".": "./src/index.ts" }, "dependencies": { ${dependencies.map((dependency) => `"@acme/${dependency}": "workspace:*"`).join(", ")} } }`,
  [`/repo/packages/${name}/src/index.ts`]: "",
})

// The name of the package numbered `index`: `p00042`.
const numbered = (index: number) => `p${String(index).padStart(5, "0")}`

// A package named `name` that depends on @acme/money.
const usesMoney = (name: string) => `{ "name": "${name}", "dependencies": { "@acme/money": "workspace:*" } }`

// What a package says when `rule` doesn't let it depend on @acme/money.
const mayNotUseMoney = (rule: string) =>
  `May not depend on "@acme/money" ("packages/money"): mayUse for ${rule} doesn't match that folder.`

const violationsOf = (files: Readonly<Record<string, MemoryEntry>>, withRules: ReadonlyArray<PackageRule> = rules) =>
  checkWorkspace("/repo", withRules).pipe(
    Effect.provide(Layer.mergeAll(memoryFileSystem({ "/repo/package.json": root, ...files }), Path.layer)),
  )

// Each violation as [folder, check].
const check = (files: Readonly<Record<string, MemoryEntry>>, withRules: ReadonlyArray<PackageRule> = rules) =>
  violationsOf(files, withRules).pipe(
    Effect.map((violations) => violations.map((violation) => [violation.folder, violation.check])),
  )

// Each violation as [folder, check, message].
const reported = (files: Readonly<Record<string, MemoryEntry>>, withRules: ReadonlyArray<PackageRule> = rules) =>
  violationsOf(files, withRules).pipe(
    Effect.map((violations) => violations.map((violation) => [violation.folder, violation.check, violation.message])),
  )

const unreadable = (files: Readonly<Record<string, MemoryEntry>>) => violationsOf(files).pipe(Effect.flip)

describe("checkWorkspace", () => {
  it.effect("accepts a workspace that follows its rules", () =>
    Effect.gen(function* () {
      const violations = yield* check({ ...money, ...shop })
      assert.deepStrictEqual(violations, [])
    }),
  )

  describe("rules", () => {
    it.effect("rejects a dependency its folder may not use, and the cycle it makes", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          ...shop,
          "/repo/packages/money/package.json": `{
            "name": "@acme/money",
            "exports": { ".": "./src/index.ts" },
            "dependencies": { "@acme/shop": "workspace:*", "effect": "catalog:" }
          }`,
        })
        assert.deepStrictEqual(violations, [
          [
            "apps/shop",
            "cycle",
            `Depends on itself: "apps/shop" → "packages/money" → "apps/shop". Move what they share into a package they all use, or reverse a dependency.`,
          ],
          [
            "packages/money",
            "dependency",
            `May not depend on "@acme/shop" ("apps/shop"): mayUse for packages/* doesn't match that folder.`,
          ],
        ])
      }),
    )

    it.effect("requires exact versions in the catalog, and workspace:* and catalog: for dependencies", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          ...shop,
          "/repo/package.json": root.replace(
            `"effect": "4.0.5"`,
            `"effect": "^4.0.5", "left-pad": "10.20.30-rc.1", "lodash": "latest", "react": "18.2", "vue": "3.4.0 || 3.5.0"`,
          ),
          "/repo/apps/shop/package.json": `{
            "name": "@acme/shop",
            "dependencies": { "@acme/money": "*", "effect": "4.0.5" }
          }`,
        })
        assert.deepStrictEqual(violations, [
          [".", "version", `The catalog gives "effect" as "^4.0.5". Give one exact version, such as "1.2.3".`],
          [".", "version", `The catalog gives "lodash" as "latest". Give one exact version, such as "1.2.3".`],
          [".", "version", `The catalog gives "react" as "18.2". Give one exact version, such as "1.2.3".`],
          [".", "version", `The catalog gives "vue" as "3.4.0 || 3.5.0". Give one exact version, such as "1.2.3".`],
          ["apps/shop", "version", `Depends on "@acme/money" as "*". Workspace packages are "workspace:*".`],
          [
            "apps/shop",
            "version",
            `Depends on "effect" as "4.0.5". npm packages are "catalog:", so the catalog holds their one version.`,
          ],
        ])
      }),
    )

    it.effect("requires the catalog to hold each npm package written catalog:, by own property only", () =>
      Effect.gen(function* () {
        const allowing = rules.map((rule) => ({
          ...rule,
          mayInstall: [...rule.mayInstall, "left-pad", "constructor", "__proto__"],
        }))
        const violations = yield* reported(
          {
            ...money,
            "/repo/packages/money/package.json": `{
              "name": "@acme/money",
              "exports": { ".": "./src/index.ts" },
              "dependencies": { "effect": "catalog:", "left-pad": "catalog:", "constructor": "catalog:", "__proto__": "catalog:" }
            }`,
          },
          allowing,
        )
        assert.deepStrictEqual(
          violations,
          ["__proto__", "constructor", "left-pad"].map((name) => [
            "packages/money",
            "version",
            `Depends on "${name}" as "catalog:", but the catalog has no "${name}". Add it to workspaces.catalog in the root package.json, at one exact version.`,
          ]),
        )
      }),
    )

    it.effect("requires the folder's name, and exports and src/index.ts only for packages with a contract", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          ...shop,
          "/repo/packages/tax/package.json": `{ "name": "tax", "dependencies": { "effect": "catalog:" } }`,
          ...capability("fees", []),
          "/repo/packages/fees/package.json": `{ "name": "@acme/fees", "exports": { ".": "./src/index.ts", "./x": "./src/x.ts" } }`,
          ...capability("vat", []),
          "/repo/packages/vat/package.json": `{ "exports": null }`,
          ...capability("ledger", []),
          "/repo/packages/ledger/package.json": `{ "exports": { "./index": "./src/index.ts" } }`,
          "/repo/apps/shop/package.json": `{
            "name": "@acme/shop",
            "exports": { ".": "./src/main.ts" },
            "dependencies": { "@acme/money": "workspace:*", "effect": "catalog:" }
          }`,
        })
        assert.deepStrictEqual(violations, [
          ["apps/shop", "contract", "Must not have exports: packages in apps/* have no contract."],
          ["packages/fees", "contract", `Must export exactly { ".": "./src/index.ts" }, its contract.`],
          ["packages/ledger", "contract", `Must export exactly { ".": "./src/index.ts" }, its contract.`],
          ["packages/ledger", "name", `Is named "". Packages in packages/* are named @acme/*: "@acme/ledger".`],
          ["packages/tax", "contract", "Has no src/index.ts file, the contract other packages import."],
          ["packages/tax", "contract", `Must export exactly { ".": "./src/index.ts" }, its contract.`],
          ["packages/tax", "name", `Is named "tax". Packages in packages/* are named @acme/*: "@acme/tax".`],
          ["packages/vat", "contract", `Must export exactly { ".": "./src/index.ts" }, its contract.`],
          ["packages/vat", "name", `Is named "". Packages in packages/* are named @acme/*: "@acme/vat".`],
        ])
      }),
    )

    it.effect("requires src/index.ts to be a file, not a folder or a link", () =>
      Effect.gen(function* () {
        const violations = yield* check({
          ...money,
          ...capability("fees", []),
          "/repo/packages/tax/package.json": `{ "name": "@acme/tax", "exports": { ".": "./src/index.ts" } }`,
          "/repo/packages/tax/src/index.ts/README.md": "",
          "/repo/packages/fees/src/index.ts": { link: "/repo/packages/money/src/index.ts" },
          "/repo/packages/vat/package.json": `{ "name": "@acme/vat", "exports": { ".": "./src/index.ts" } }`,
          "/repo/packages/vat/src": "a file where a folder should be",
        })
        assert.deepStrictEqual(violations, [
          ["packages/fees", "contract"],
          ["packages/tax", "contract"],
          ["packages/vat", "contract"],
        ])
      }),
    )

    it.effect("matches packages and rules by folder, prefix, and parent, applying the first rule that matches", () =>
      Effect.gen(function* () {
        const strict = { contract: false, mayUse: [], mayInstall: [], mayInstallForDevelopment: [] }
        const moreRules: ReadonlyArray<PackageRule> = [
          { folders: "apps/web-*", name: "@acme/*", ...strict },
          { folders: "tools", name: "@acme/tools", ...strict },
          { folders: "product/apps/*", name: "@acme/*", ...strict },
          ...rules,
        ]
        const violations = yield* reported(
          {
            ...money,
            "/repo/package.json": rootWith(["packages/*", "apps/web-*", "tools", "docs", "product/apps/*"]),
            "/repo/apps/web-shop/package.json": usesMoney("@acme/web-shop"),
            "/repo/apps/admin/package.json": `{ "name": "not matched, so not read" }`,
            "/repo/tools/package.json": usesMoney("@acme/tools"),
            "/repo/docs/package.json": `{ "name": "@acme/docs", "overrides": {} }`,
            "/repo/product/apps/web/package.json": usesMoney("@acme/web"),
          },
          moreRules,
        )
        assert.deepStrictEqual(violations, [
          ["apps/web-shop", "dependency", mayNotUseMoney("apps/web-*")],
          ["docs", "rule", `No rule covers "docs". Add a rule for it, or move the package.`],
          [
            "docs",
            "unsupported",
            "Has overrides, which these rules don't support: it changes the version any dependency gets, past the catalog.",
          ],
          ["product/apps/web", "dependency", mayNotUseMoney("product/apps/*")],
          ["tools", "dependency", mayNotUseMoney("tools")],
        ])
      }),
    )

    it.effect(
      "checks every dependency field, allows development packages in devDependencies only, and counts each for cycles",
      () =>
        Effect.gen(function* () {
          const violations = yield* reported({
            ...money,
            ...shop,
            "/repo/packages/money/package.json": `{
            "name": "@acme/money",
            "exports": { ".": "./src/index.ts" },
            "dependencies": { "vitest": "catalog:" },
            "optionalDependencies": { "left-pad": "catalog:" },
            "peerDependencies": { "@acme/shop": "workspace:*" }
          }`,
          })
          assert.deepStrictEqual(violations, [
            [
              "apps/shop",
              "cycle",
              `Depends on itself: "apps/shop" → "packages/money" → "apps/shop". Move what they share into a package they all use, or reverse a dependency.`,
            ],
            [
              "packages/money",
              "dependency",
              `Has "vitest" in dependencies. It is for tests and tools only: move it to devDependencies.`,
            ],
            [
              "packages/money",
              "dependency",
              `May not depend on "@acme/shop" ("apps/shop"): mayUse for packages/* doesn't match that folder.`,
            ],
            ["packages/money", "dependency", `May not depend on "left-pad": it isn't in mayInstall for packages/*.`],
            [
              "packages/money",
              "version",
              `Depends on "left-pad" as "catalog:", but the catalog has no "left-pad". Add it to workspaces.catalog in the root package.json, at one exact version.`,
            ],
          ])
        }),
    )

    it.effect(
      "reports bundled dependencies, overrides, resolutions, patches, and trusted dependencies as unsupported",
      () =>
        Effect.gen(function* () {
          const violations = yield* check({
            ...money,
            "/repo/package.json": rootWith(
              ["packages/*"],
              `, "overrides": {}, "resolutions": {}, "patchedDependencies": {}, "trustedDependencies": []`,
            ),
            "/repo/packages/money/package.json": `{
            "name": "@acme/money",
            "exports": { ".": "./src/index.ts" },
            "bundleDependencies": ["left-pad"],
            "bundledDependencies": false
          }`,
          })
          assert.deepStrictEqual(violations, [
            [".", "unsupported"],
            [".", "unsupported"],
            [".", "unsupported"],
            [".", "unsupported"],
            ["packages/money", "unsupported"],
            ["packages/money", "unsupported"],
          ])
        }),
    )

    it.effect("allows the root package.json devDependencies only, written like any package's", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          "/repo/package.json": rootWith(
            ["packages/*"],
            `,
            "dependencies": { "left-pad": "^1.0.0" },
            "optionalDependencies": { "@acme/money": "workspace:*" },
            "peerDependencies": { "effect": "catalog:" },
            "devDependencies": { "vitest": "catalog:", "@acme/money": "workspace:*", "lodash": "github:acme/lodash" }`,
          ),
        })
        assert.deepStrictEqual(violations, [
          [
            ".",
            "dependency",
            `Has "@acme/money" in optionalDependencies. The root package.json has only devDependencies, for tools: declare it in the packages that use it.`,
          ],
          [
            ".",
            "dependency",
            `Has "effect" in peerDependencies. The root package.json has only devDependencies, for tools: declare it in the packages that use it.`,
          ],
          [
            ".",
            "dependency",
            `Has "left-pad" in dependencies. The root package.json has only devDependencies, for tools: declare it in the packages that use it.`,
          ],
          [
            ".",
            "version",
            `Depends on "lodash" as "github:acme/lodash". npm packages are "catalog:", so the catalog holds their one version.`,
          ],
        ])
      }),
    )

    it.effect(
      "refuses a top-level catalog or catalogs, and named catalogs: the one catalog is workspaces.catalog",
      () =>
        Effect.gen(function* () {
          const violations = yield* reported({
            ...money,
            "/repo/package.json": `{
            "workspaces": { "packages": ["packages/*"], ${catalog}, "catalogs": { "testing": { "vitest": "4.0.0" } } },
            "catalog": { "left-pad": "1.0.0" },
            "catalogs": { "old": { "effect": "3.0.0" } }
          }`,
          })
          assert.deepStrictEqual(violations, [
            [
              ".",
              "unsupported",
              "Has catalog, which these rules don't support: the one catalog is workspaces.catalog in the root package.json.",
            ],
            [
              ".",
              "unsupported",
              "Has catalogs, which these rules don't support: the one catalog is workspaces.catalog in the root package.json.",
            ],
            [
              ".",
              "unsupported",
              "Has workspaces.catalogs, which these rules don't support: the one catalog is workspaces.catalog.",
            ],
          ])
        }),
    )
  })

  describe("names", () => {
    it.effect("reports each package that shares a name", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          ...shop,
          "/repo/apps/money/package.json": `{ "name": "@acme/money" }`,
        })
        assert.deepStrictEqual(violations, [
          [
            "apps/money",
            "name",
            `Shares the name "@acme/money" with "packages/money". Give each package its own name, so a dependency on it means one package.`,
          ],
          [
            "packages/money",
            "name",
            `Shares the name "@acme/money" with "apps/money". Give each package its own name, so a dependency on it means one package.`,
          ],
        ])
      }),
    )

    it.effect("quotes text from a package.json in messages, escaping everything outside printable ASCII", () =>
      Effect.gen(function* () {
        const violations = yield* reported({
          ...money,
          "/repo/packages/money/package.json": `{
            "name": "@acme/money\\n::error::forged\\u001b[2K\\ud83d\\ude00",
            "exports": { ".": "./src/index.ts" },
            "dependencies": { "\\u0430pple\\"\\\\": "catalog:\\r" }
          }`,
        })
        assert.deepStrictEqual(violations, [
          [
            "packages/money",
            "dependency",
            `May not depend on "\\u0430pple\\"\\\\": it isn't in mayInstall for packages/*.`,
          ],
          [
            "packages/money",
            "name",
            `Is named "@acme/money\\n::error::forged\\u001b[2K\\ud83d\\ude00". Packages in packages/* are named @acme/*: "@acme/money".`,
          ],
          [
            "packages/money",
            "version",
            `Depends on "\\u0430pple\\"\\\\" as "catalog:\\u000d". npm packages are "catalog:", so the catalog holds their one version.`,
          ],
        ])
      }),
    )
  })

  describe("cycles", () => {
    it.effect("reports one cycle for each group of packages that depend on each other", () =>
      Effect.gen(function* () {
        const names = ["a", "b", "c", "d", "e"]
        const files = Object.assign(
          {},
          ...names.map((name) =>
            capability(
              name,
              names.filter((other) => other !== name),
            ),
          ),
          // f also depends on a, in a group found before it.
          capability("f", ["f", "a"]),
          capability("g", ["h"]),
          capability("h", ["i"]),
          capability("i", ["g"]),
          // j leads into a group, k to m, whose shortest cycle is k → m → k, and n to o, which
          // depends on itself.
          capability("j", ["k"]),
          capability("k", ["l", "m"]),
          capability("l", ["m"]),
          capability("m", ["k"]),
          capability("n", ["o"]),
          capability("o", ["o"]),
        )
        const violations = yield* reported({ ...money, ...files })
        assert.deepStrictEqual(violations, [
          [
            "packages/a",
            "cycle",
            `Depends on itself: "packages/a" → "packages/b" → "packages/a". It is one of 5 packages that each depend on all the others: "packages/a", "packages/b", "packages/c", "packages/d", "packages/e". Move what they share into a package they all use, or reverse a dependency.`,
          ],
          [
            "packages/f",
            "cycle",
            `Depends on itself: "packages/f" → "packages/f". Move what they share into a package they all use, or reverse a dependency.`,
          ],
          [
            "packages/g",
            "cycle",
            `Depends on itself: "packages/g" → "packages/h" → "packages/i" → "packages/g". Move what they share into a package they all use, or reverse a dependency.`,
          ],
          [
            "packages/k",
            "cycle",
            `Depends on itself: "packages/k" → "packages/m" → "packages/k". It is one of 3 packages that each depend on all the others: "packages/k", "packages/l", "packages/m". Move what they share into a package they all use, or reverse a dependency.`,
          ],
          [
            "packages/o",
            "cycle",
            `Depends on itself: "packages/o" → "packages/o". Move what they share into a package they all use, or reverse a dependency.`,
          ],
        ])
      }),
    )
  })

  describe("a key written twice", () => {
    it.effect("refuses a package.json that repeats a key, at any depth, compared by decoded value", () =>
      Effect.gen(function* () {
        // Bun reads the first of two keys, JSON.parse the last: each hides what the other sees.
        const hiddenDependency = yield* unreadable({
          ...money,
          "/repo/packages/money/package.json": `{ "name": "@acme/money", "exports": { ".": "./src/index.ts" },
            "dependencies": { "left-pad": "1.0.0" }, "dependencies": { "effect": "catalog:" } }`,
        })
        assert.strictEqual(
          hiddenDependency.message,
          `packages/money/package.json: it has the key "dependencies" twice in one object, and package managers disagree on which one counts. Keep one.`,
        )

        const hiddenWorkspace = yield* unreadable({
          ...money,
          "/repo/package.json": `{ "workspaces": { "packages": ["packages/*", "evil/*"] }, "workspaces": ["packages/*"] }`,
        })
        assert.strictEqual(hiddenWorkspace.path, "package.json")

        // "effect" is "effect", nested in an array of objects.
        const escapedKey = yield* unreadable({
          ...money,
          "/repo/packages/money/package.json": `{ "name": "@acme/money", "config": [{ "dependencies": { "effect": "1", "\\u0065ffect": "2" } }] }`,
        })
        assert.include(escapedKey.reason, `"effect"`)
      }),
    )

    it.effect(
      "reads braces, brackets, quotes, and escapes inside strings as text, and the same key in other objects",
      () =>
        Effect.gen(function* () {
          const violations = yield* check({
            ...money,
            "/repo/packages/money/package.json": `{
            "name": "@acme/money",
            "description": "}{\\"name\\": [\\"x\\"], \\\\",
            "exports": { ".": "./src/index.ts" },
            "keywords": [{ "name": 1 }, { "name": 2 }, "name", "name"],
            "config": { "inner": { "name": 1, "list": [] }, "name": 2, "list": [] },
            "dependencies": { "effect": "catalog:" }
          }`,
          })
          assert.deepStrictEqual(violations, [])
        }),
    )
  })

  describe("supported shape", () => {
    it.effect("refuses workspace patterns outside the supported shape", () =>
      Effect.gen(function* () {
        const patterns = [
          "../*",
          "packages/../money",
          "./packages/*",
          "packages//*",
          "packages/",
          "/etc/*",
          "*",
          "Packages/*",
          "packages/Money*",
          "packages/*/src",
          "packages/a*b*",
          "packages/*-app",
          "::group::passed",
          "packages/~backup",
        ]
        for (const pattern of patterns) {
          const error = yield* unreadable({ ...money, "/repo/package.json": rootWith(["packages/*", pattern]) })
          assert.strictEqual(
            error.message,
            `package.json: the workspace pattern "${pattern}" isn't supported: a folder, or "parent/*", whose folder names are lowercase letters, digits, ".", "_", and "-", starting with a letter or digit`,
            pattern,
          )
        }
      }),
    )

    it.effect("dies on a rule whose pattern is outside the supported shape, a bug in the caller", () =>
      Effect.gen(function* () {
        const outside = rules.map((rule) => ({ ...rule, folders: "../*", mayUse: ["Packages/*"] }))
        const exit = yield* violationsOf({ ...money }, outside).pipe(Effect.exit)
        assert.isTrue(Exit.hasDies(exit))
        assert.include(
          Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "",
          `A PackageRule pattern isn't supported: ../*, Packages/*`,
        )
      }),
    )

    it.effect(
      "reports a link or a folder with an unsupported name where a pattern finds packages, and follows no link",
      () =>
        Effect.gen(function* () {
          const forbidden = `{ "name": "@acme/linked", "dependencies": { "left-pad": "1.0.0" } }`
          const violations = yield* reported({
            ...money,
            "/repo/elsewhere/linked/package.json": forbidden,
            "/repo/packages/linked": { link: "/repo/elsewhere/linked" },
            "/repo/packages/MyLib/package.json": forbidden,
            "/repo/packages/~backup/package.json": forbidden,
            "/repo/packages/README.md": "# Packages\n",
            "/repo/packages/.cache/package.json": forbidden,
            "/repo/packages/notes/README.md": "",
          })
          assert.deepStrictEqual(violations, [
            [
              "packages",
              "unsupported",
              `Has "linked", a link, where packages/* finds packages: links aren't supported.`,
            ],
            [
              "packages",
              "unsupported",
              `Has the folder "MyLib", which packages/* matches, and folder names are lowercase letters, digits, ".", "_", and "-", starting with a letter or digit.`,
            ],
            [
              "packages",
              "unsupported",
              `Has the folder "~backup", which packages/* matches, and folder names are lowercase letters, digits, ".", "_", and "-", starting with a letter or digit.`,
            ],
          ])
        }),
    )

    it.effect("fails when a folder the root names on its own, or a pattern's parent, isn't a plain folder", () =>
      Effect.gen(function* () {
        const missing = yield* unreadable({ ...money, "/repo/package.json": rootWith(["packages/*", "tools/release"]) })
        assert.strictEqual(
          missing.message,
          "tools/release: the root package.json names it as a workspace, but it isn't a folder with a package.json",
        )

        const withoutManifest = yield* unreadable({
          ...money,
          "/repo/package.json": rootWith(["packages/*", "tools/release"]),
          "/repo/tools/release/README.md": "",
        })
        assert.strictEqual(withoutManifest.path, "tools/release")

        const linked = yield* unreadable({
          ...money,
          "/repo/package.json": rootWith(["packages/*", "tools/release"]),
          "/repo/elsewhere/release/package.json": `{ "name": "@acme/release" }`,
          "/repo/tools/release": { link: "/repo/elsewhere/release" },
        })
        assert.strictEqual(linked.message, "tools/release: it is a link, and links aren't supported")

        const linkedParent = yield* unreadable({
          ...money,
          "/repo/elsewhere/shop/package.json": `{ "name": "@acme/shop" }`,
          "/repo/apps": { link: "/repo/elsewhere" },
        })
        assert.strictEqual(linkedParent.message, "apps: it is a link, and links aren't supported")
      }),
    )

    it.effect("refuses a package.json that is missing, a link, not a regular file, or larger than 1 MiB", () =>
      Effect.gen(function* () {
        const missingRoot = yield* checkWorkspace("/repo", rules).pipe(
          Effect.provide(Layer.mergeAll(memoryFileSystem({ "/repo/README.md": "" }), Path.layer)),
          Effect.flip,
        )
        assert.strictEqual(missingRoot._tag, "WorkspaceUnreadable")
        assert.strictEqual(missingRoot.message, "package.json: it is missing")
        assert.include(Cause.pretty(Cause.fail(missingRoot)), missingRoot.message)

        const link = yield* unreadable({
          ...money,
          "/repo/elsewhere/package.json": `{ "name": "@acme/money" }`,
          "/repo/packages/money/package.json": { link: "/repo/elsewhere/package.json" },
        })
        assert.strictEqual(link.message, "packages/money/package.json: it is a link, not a regular file")

        const folder = yield* unreadable({ ...money, "/repo/packages/evil/package.json/index.js": "" })
        assert.strictEqual(folder.message, "packages/evil/package.json: it is a Directory, not a regular file")

        const atLimit = `{ "name": "@acme/money", "exports": { ".": "./src/index.ts" }, "description": "" }`
        const oneMiB = atLimit.replace(`""`, `"${"x".repeat(1_048_576 - atLimit.length)}"`)
        const accepted = yield* check({ ...money, "/repo/packages/money/package.json": oneMiB })
        assert.deepStrictEqual(accepted, [])
        const large = yield* unreadable({ ...money, "/repo/packages/money/package.json": `${oneMiB} ` })
        assert.strictEqual(large.reason, "it is larger than 1 MiB")
      }),
    )

    it.effect("says what failed when a file or folder can't be read", () =>
      Effect.gen(function* () {
        const manifest = yield* unreadable({ ...money, ...shop, "/repo/apps/shop/package.json": { denied: true } })
        assert.strictEqual(
          manifest.message,
          "apps/shop/package.json: reading it failed: PermissionDenied: FileSystem.readFileString (/repo/apps/shop/package.json)",
        )

        const folder = yield* unreadable({ ...money, ...shop, "/repo/apps": { denied: true } })
        assert.strictEqual(
          folder.message,
          "apps: listing it failed: PermissionDenied: FileSystem.readDirectory (/repo/apps)",
        )

        const entry = yield* unreadable({ ...money, "/repo/packages/money/src": { denied: true } })
        assert.strictEqual(
          entry.message,
          "packages/money/src/index.ts: reading it failed: PermissionDenied: FileSystem.stat (/repo/packages/money/src/index.ts)",
        )
      }),
    )

    it.effect("fails on a package.json that isn't valid, naming the file", () =>
      Effect.gen(function* () {
        const syntax = yield* unreadable({ ...money, "/repo/packages/money/package.json": `{ "name": ` })
        assert.strictEqual(
          syntax.message,
          "packages/money/package.json: it isn't a valid package.json: Expected a valid JSON string",
        )

        // Schema's message spans two lines; the reason keeps it to one.
        const type = yield* unreadable({
          ...money,
          "/repo/packages/money/package.json": `{ "dependencies": { "x": 1 } }`,
        })
        assert.strictEqual(type.reason, `it isn't a valid package.json: Expected string\\n  at ["dependencies"]["x"]`)

        const noWorkspaces = yield* unreadable({ ...money, "/repo/package.json": `{ "name": "acme" }` })
        assert.strictEqual(noWorkspaces.message, "package.json: it has no workspaces")
      }),
    )
  })

  // Worst cases, last, so a run that fails earlier stops before them.
  describe("worst cases", () => {
    // 1,000 packages sharing a name and depending on it once made 1,000,000 violations.
    it.live("reports one violation for each package and name, however many packages share the name", () =>
      Effect.gen(function* () {
        const count = 1_000
        const sharing: ReadonlyArray<PackageRule> = [
          {
            folders: "packages/*",
            name: "x",
            contract: false,
            mayUse: [],
            mayInstall: [],
            mayInstallForDevelopment: [],
          },
        ]
        const files = Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            `/repo/packages/${numbered(index)}/package.json`,
            `{ "name": "x", "dependencies": { "x": "workspace:*" } }`,
          ]),
        )
        const start = yield* Clock.currentTimeMillis
        const violations = yield* violationsOf({ ...files, "/repo/package.json": rootWith(["packages/*"]) }, sharing)
        const end = yield* Clock.currentTimeMillis
        assert.strictEqual(violations.length, count)
        assert.isTrue(violations.every((violation) => violation.check === "name"))
        assert.include(violations[0]?.message ?? "", `"packages/p00019", "packages/p00020", and 979 more.`)
        assert.isBelow(end - start, 10_000)
      }),
    )

    // Each key is read once: a scan that restarted at every key would take seconds here.
    it.live("finds a repeated key in a 1 MiB package.json in time linear in its size", () =>
      Effect.gen(function* () {
        const keys = Array.from({ length: 70_000 }, (_, index) => `"k${index}": 0`).join(", ")
        const nested = `${"[".repeat(50_000)}${"]".repeat(50_000)}`
        const manifest = `{ "name": "@acme/money", "nested": ${nested}, "config": { ${keys}, "k0": 1 } }`
        const start = yield* Clock.currentTimeMillis
        const error = yield* unreadable({ ...money, "/repo/packages/money/package.json": manifest })
        const end = yield* Clock.currentTimeMillis
        assert.include(error.reason, `"k0"`)
        assert.isBelow(end - start, 5_000)
      }),
    )

    it.live(
      "finds a cycle through 50,000 packages without overflowing the stack, in a message of bounded length",
      () =>
        Effect.gen(function* () {
          const count = 50_000
          const files = Object.assign(
            {},
            ...Array.from({ length: count }, (_, index) =>
              capability(numbered(index), [numbered((index + 1) % count)]),
            ),
          )
          const violations = yield* reported({ ...money, ...files })
          assert.deepStrictEqual(
            violations.map(([folder, kind]) => [folder, kind]),
            [["packages/p00000", "cycle"]],
          )
          assert.include(violations[0]?.[2] ?? "", `"packages/p00018" → "packages/p00019", and 49981 more.`)
        }),
      60_000,
    )
  })
})
