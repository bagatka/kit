# @bagatka/workspace-rules

Checks that a JavaScript workspace's packages follow your rules: what each is named, whether others
may import it, and which packages it may depend on, at which versions.

## Install

```sh
npm install --save-dev @bagatka/workspace-rules effect
```

Its peer dependency is `effect`, at the minor version it is built with. It reads files through
Effect's `FileSystem`, so a program runs it on Bun or Node with Effect's platform package for it.

## Use it

```ts
import { checkWorkspace } from "@bagatka/workspace-rules"
import type { PackageRule } from "@bagatka/workspace-rules"

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

// Needs FileSystem and Path: BunServices.layer or NodeServices.layer provides both.
const violations = yield* checkWorkspace(".", rules)
for (const violation of violations) {
  yield* Console.error(`${violation.folder}: ${violation.message}`)
}
// packages/money: May not depend on "@acme/shop" ("apps/shop"): mayUse for packages/* doesn't match that folder.
```

When the workspace can't be checked as a whole, such as a `package.json` that is missing or isn't
valid JSON, the check fails with `WorkspaceUnreadable`: its `path` names the file or folder, its
`reason` says what is wrong, and its `message` is both, `packages/money/package.json: it is larger
than 1 MiB`.

## What it is for

It reports mistakes in your own repository, for the people and agents who work in it. It is strict
about the repository's shape: anything outside the shape below is refused, as a violation or as
`WorkspaceUnreadable`, saying what isn't supported, never skipped or guessed at. It isn't a defense
against a hostile pull request, which a person reviews.

## Supported shape

- **Workspace patterns** in the root `package.json` are a folder (`tools`, `product/foundation`) or
  a parent and a last segment ending in `*` (`packages/*`, `packages/cloudflare-*`). Any other
  pattern fails with `WorkspaceUnreadable`; a `PackageRule` with one is a bug in the caller, and
  dies.
- **Folder names**, in patterns and of packages, are lowercase ASCII letters and digits, `.`, `_`,
  and `-`, starting with a letter or digit.
- **In a `parent/*` folder,** a folder with a `package.json` is a package. Plain files are ignored,
  and so are names starting with `.` (`.git`, `.DS_Store`). A folder with any other name (`MyLib`,
  `~backup`) is a violation, and so is a link, file or folder, which is never followed. A missing
  parent holds no packages; a parent that is a link fails with `WorkspaceUnreadable`.
- **A folder the root names on its own** is a folder, not a link, with a `package.json`, or the
  check fails with `WorkspaceUnreadable`.
- **Each `package.json`,** the root's and each package's, is a regular file, not a link, of at most
  1 MiB by its size on disk, valid JSON with no key twice in one object; otherwise the check fails
  with `WorkspaceUnreadable`. **`src/index.ts`** is a regular file, not a link or a folder.
- **Dependencies** are in `dependencies`, `devDependencies`, `optionalDependencies`, and
  `peerDependencies`; a workspace package is `workspace:*`, an npm package `catalog:`, with one
  exact version in the root's `workspaces.catalog`.

Not supported, and reported: `bundleDependencies`, `bundledDependencies`, `overrides`,
`resolutions`, `patchedDependencies`, and `trustedDependencies` in any `package.json`; a top-level
`catalog` or `catalogs`, and named catalogs in `workspaces.catalogs`; the root's `dependencies`,
`optionalDependencies`, and `peerDependencies`; two packages with one name.

## Owns

- **Rules:** what each check means:
  - a package's name comes from its folder, and no two packages share one;
  - a package with a contract exports exactly `{ ".": "./src/index.ts" }` and has that file, and
    one without exports nothing;
  - workspace dependencies are allowed by folder, npm dependencies by name, and npm packages only
    for tests and tools only in `devDependencies`;
  - the catalog holds exact versions;
  - the root `package.json` has `devDependencies` only, for tools, written like any package's;
  - there are no dependency cycles.

## Does not own

- **Which rules a workspace has.** The caller passes them; this repository's are in
  `tools/src/workspace-rules.ts`.
- **Whether imports match what `package.json` declares.** Bun's isolated installs make an import of
  another package's dependency fail to resolve, but not an import of what the root installs: every
  package finds the root's `node_modules` by walking up, so an undeclared import of a root
  `devDependency` (a linter, the type checker) resolves, in the type checker and at run time. These
  rules keep the root to `devDependencies`, which narrows that, but they can't see imports: telling
  imports from text that only looks like one needs a parser, which this package doesn't take on.
- **The file system.** It reads through Effect's `FileSystem` and `Path`, which the caller provides.

## Contract

`src/index.ts`. Callers pass a workspace root and their rules, and get back every violation, sorted
by folder, as plain data to print or count.

## Depends on

`effect`.

## Decisions and constraints

- Reads the root `package.json`, the folders its patterns name, and each package's `package.json`;
  it follows no link and changes nothing. `readLink` tells a link from anything else, so a link is
  found without being followed.
- A `package.json` with a key twice in one object is refused because Bun reads the first of the two
  and JSON's parsers the last, so either could hide a dependency or a workspace pattern from the
  other. Keys compare by their decoded value: `"a"` and `"\u0061"` are one key.
- Time and memory are linear in the size of each file it reads, and in the packages and their
  dependencies. Each `parent/*` pattern lists its parent folder, so many patterns over one large
  folder take time in proportion to both; a workspace lists a handful.
- What it returns is linear in what it reads, too: at most one violation for each catalog entry,
  each unsupported field, each of the root's dependencies, and each unsupported entry in a
  `parent/*` folder; for each package, at most one for its rule, one for its name, one for a name it
  shares, and two for its contract, and at most two for each dependency it declares; and one for
  each group of packages in a cycle. A message quotes at most two texts from a `package.json`, and
  each list of folders in it shows at most 20, then how many more there are.
- Text from a `package.json` or a folder's listing (names, specifiers, versions) is quoted in
  messages and reasons as a JSON string literal with every character outside printable ASCII
  escaped, so it can't add a line to a log, and two different names never print alike. Folders are
  supported names, so `Violation.folder` and `WorkspaceUnreadable.path` print as they are.
- A name two packages share means no package until it is fixed: each is reported, and a dependency
  on the name is checked for how it is written, but not for which folder it reaches or the cycles
  it makes.
- Reports one cycle for each group of packages that each depend on all the others (a strongly
  connected component): the shortest cycle through the group's first folder, and the group when it
  is larger than the cycle. Fix one and run it again.
