import { Order } from "effect"

import { findCycles } from "./find-cycles.ts"
import type { Cycle } from "./find-cycles.ts"
import { matchesFolder } from "./folder-pattern.ts"
import type { PackageJson } from "./package-json.ts"
import type { PackageRule } from "./package-rule.ts"
import { quoted } from "./printable-text.ts"
import type { Member, Workspace } from "./read-workspace.ts"
import { Violation } from "./violation.ts"

/** Every way `workspace` breaks `rules`, sorted by folder, then check, then message. */
export const findViolations = (workspace: Workspace, rules: ReadonlyArray<PackageRule>): ReadonlyArray<Violation> => {
  const groups = groupByName(workspace.members)
  // A name two packages share is reported, and means no package until it is fixed: a dependency on
  // it is checked for how it is written, not for which folder it reaches or the cycles it makes.
  const membersByName = new Map(
    [...groups].flatMap(([name, group]) => (group.length === 1 ? group.map((member) => [name, member] as const) : [])),
  )
  const workspaceNames = new Set(groups.keys())
  const violations = [
    ...workspace.unsupported,
    ...rootViolations(workspace.root, workspace.catalog, workspaceNames),
    ...sharedNameViolations(groups),
    ...workspace.members.flatMap((member) =>
      memberViolations(member, rules, membersByName, workspaceNames, workspace.catalog),
    ),
    ...findCycles(edgesBetween(workspace.members, membersByName)).map(
      (cycle) => new Violation({ folder: cycle.start, check: "cycle", message: cycleMessage(cycle) }),
    ),
  ]
  return violations.toSorted(byFolderCheckMessage)
}

const byFolderCheckMessage = Order.combineAll<Violation>([
  Order.mapInput(Order.String, (violation) => violation.folder),
  Order.mapInput(Order.String, (violation) => violation.check),
  Order.mapInput(Order.String, (violation) => violation.message),
])

// How many names a message lists before it says how many more there are.
const shownNames = 20

// Text from the workspace, each item quoted, at most `shownNames` of them, then how many of `total`
// are left.
const quotedList = (items: ReadonlyArray<string>, separator: string, total = items.length): string => {
  const shown = items.slice(0, shownNames).map(quoted).join(separator)
  const hidden = total - Math.min(items.length, shownNames)
  return hidden > 0 ? `${shown}, and ${hidden} more` : shown
}

const groupByName = (members: ReadonlyArray<Member>): ReadonlyMap<string, ReadonlyArray<Member>> => {
  const byName = new Map<string, Array<Member>>()
  for (const member of members) {
    const name = member.manifest.name
    if (name === undefined) {
      continue
    }
    const group = byName.get(name)
    if (group === undefined) {
      byName.set(name, [member])
    } else {
      group.push(member)
    }
  }
  return byName
}

const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const

// Every dependency a manifest declares, in each field package managers install from.
const declaredDependencies = (manifest: PackageJson) =>
  dependencyFields.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).map(([name, specifier]) => ({ field, name, specifier })),
  )

// Fields that change what is installed or run in ways the rules can't check, and why.
const unsupportedFields = [
  ["bundleDependencies", "bundled packages ship inside this one, past the rules for what it may install"],
  ["bundledDependencies", "bundled packages ship inside this one, past the rules for what it may install"],
  ["overrides", "it changes the version any dependency gets, past the catalog"],
  ["resolutions", "it changes the version any dependency gets, past the catalog"],
  ["patchedDependencies", "it changes an installed package's code"],
  ["trustedDependencies", "it lets dependencies run their install scripts"],
  ["catalog", "the one catalog is workspaces.catalog in the root package.json"],
  ["catalogs", "the one catalog is workspaces.catalog in the root package.json"],
] as const

const unsupportedField = (folder: string, field: string, why: string) =>
  new Violation({ folder, check: "unsupported", message: `Has ${field}, which these rules don't support: ${why}.` })

const unsupportedViolations = (folder: string, manifest: PackageJson) =>
  unsupportedFields
    .filter(([field]) => manifest[field] !== undefined)
    .map(([field, why]) => unsupportedField(folder, field, why))

// What is wrong with how a dependency is written: a workspace package as "workspace:*", and an npm
// package as "catalog:", which the catalog has. At most one message.
const specifierProblems = (
  name: string,
  specifier: string,
  isWorkspacePackage: boolean,
  catalog: Readonly<Record<string, string>>,
): ReadonlyArray<string> => {
  if (isWorkspacePackage) {
    return specifier === "workspace:*"
      ? []
      : [`Depends on ${quoted(name)} as ${quoted(specifier)}. Workspace packages are "workspace:*".`]
  }
  if (specifier !== "catalog:") {
    return [
      `Depends on ${quoted(name)} as ${quoted(specifier)}. npm packages are "catalog:", so the catalog holds their one version.`,
    ]
  }
  // An own property only, so `constructor` or `__proto__` is never found on Object.prototype.
  return Object.hasOwn(catalog, name)
    ? []
    : [
        `Depends on ${quoted(name)} as "catalog:", but the catalog has no ${quoted(name)}. Add it to workspaces.catalog in the root package.json, at one exact version.`,
      ]
}

// A version with optional prerelease tag; ranges, tags, and URLs are not exact.
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const rootViolation = (check: Violation["check"], message: string) => new Violation({ folder: ".", check, message })

const rootViolations = (
  root: PackageJson,
  catalog: Readonly<Record<string, string>>,
  workspaceNames: ReadonlySet<string>,
): ReadonlyArray<Violation> => {
  const inexact = Object.entries(catalog)
    .filter(([, version]) => !exactVersion.test(version))
    .map(([name, version]) =>
      rootViolation(
        "version",
        `The catalog gives ${quoted(name)} as ${quoted(version)}. Give one exact version, such as "1.2.3".`,
      ),
    )
  // Every package can import what the root installs without declaring it, so the root installs
  // only tools, written like any package's dependencies.
  const declared = declaredDependencies(root).flatMap(({ field, name, specifier }) =>
    field === "devDependencies"
      ? specifierProblems(name, specifier, workspaceNames.has(name), catalog).map((message) =>
          rootViolation("version", message),
        )
      : [
          rootViolation(
            "dependency",
            `Has ${quoted(name)} in ${field}. The root package.json has only devDependencies, for tools: declare it in the packages that use it.`,
          ),
        ],
  )
  const namedCatalogs =
    "catalogs" in (root.workspaces ?? {})
      ? [unsupportedField(".", "workspaces.catalogs", "the one catalog is workspaces.catalog")]
      : []
  return [...inexact, ...declared, ...unsupportedViolations(".", root), ...namedCatalogs]
}

// One violation for each package that shares its name, naming at most `shownNames` of the others,
// taken from the group's first ones, so a large group costs no more than a small one per package.
const sharedNameViolations = (groups: ReadonlyMap<string, ReadonlyArray<Member>>) =>
  [...groups].flatMap(([name, group]) =>
    group.length < 2
      ? []
      : group.map((member) => {
          const others = group
            .slice(0, shownNames + 1)
            .filter((other) => other !== member)
            .map((other) => other.folder)
          return new Violation({
            folder: member.folder,
            check: "name",
            message: `Shares the name ${quoted(name)} with ${quotedList(others, ", ", group.length - 1)}. Give each package its own name, so a dependency on it means one package.`,
          })
        }),
  )

const memberViolations = (
  member: Member,
  rules: ReadonlyArray<PackageRule>,
  membersByName: ReadonlyMap<string, Member>,
  workspaceNames: ReadonlySet<string>,
  catalog: Readonly<Record<string, string>>,
): ReadonlyArray<Violation> => {
  const { folder, manifest } = member
  const violation = (check: Violation["check"], message: string) => new Violation({ folder, check, message })
  const unsupported = unsupportedViolations(folder, manifest)

  const rule = rules.find((candidate) => matchesFolder(candidate.folders, folder))
  if (rule === undefined) {
    return [
      ...unsupported,
      violation("rule", `No rule covers ${quoted(folder)}. Add a rule for it, or move the package.`),
    ]
  }
  const violations: Array<Violation> = [...unsupported]

  // A replacer function, so `$&` or `$'` in a folder's name would be taken as it is.
  const folderName = folder.slice(folder.lastIndexOf("/") + 1)
  const expectedName = rule.name.replace("*", () => folderName)
  if (manifest.name !== expectedName) {
    violations.push(
      violation(
        "name",
        `Is named ${quoted(manifest.name ?? "")}. Packages in ${rule.folders} are named ${rule.name}: ${quoted(expectedName)}.`,
      ),
    )
  }
  if (rule.contract && !isContractExports(manifest.exports)) {
    violations.push(violation("contract", `Must export exactly { ".": "./src/index.ts" }, its contract.`))
  }
  if (rule.contract && !member.hasEntry) {
    violations.push(violation("contract", "Has no src/index.ts file, the contract other packages import."))
  }
  if (!rule.contract && manifest.exports !== undefined) {
    violations.push(violation("contract", `Must not have exports: packages in ${rule.folders} have no contract.`))
  }

  // At most two violations for each declared dependency: how it is written, and whether it is allowed.
  for (const { field, name, specifier } of declaredDependencies(manifest)) {
    const isWorkspacePackage = workspaceNames.has(name)
    for (const message of specifierProblems(name, specifier, isWorkspacePackage, catalog)) {
      violations.push(violation("version", message))
    }
    const target = membersByName.get(name)
    if (target !== undefined && !rule.mayUse.some((pattern) => matchesFolder(pattern, target.folder))) {
      violations.push(
        violation(
          "dependency",
          `May not depend on ${quoted(name)} (${quoted(target.folder)}): mayUse for ${rule.folders} doesn't match that folder.`,
        ),
      )
    }
    const allowedForDevelopment = rule.mayInstallForDevelopment.includes(name)
    const allowed = rule.mayInstall.includes(name) || (field === "devDependencies" && allowedForDevelopment)
    if (!isWorkspacePackage && !allowed) {
      violations.push(
        violation(
          "dependency",
          allowedForDevelopment
            ? `Has ${quoted(name)} in ${field}. It is for tests and tools only: move it to devDependencies.`
            : `May not depend on ${quoted(name)}: it isn't in mayInstall for ${rule.folders}.`,
        ),
      )
    }
  }
  return violations
}

// Each package's folder and the folders of the workspace packages it depends on, by a name only it has.
const edgesBetween = (members: ReadonlyArray<Member>, membersByName: ReadonlyMap<string, Member>) =>
  new Map(
    members.map((member) => {
      const targets = declaredDependencies(member.manifest).flatMap(({ name }) => membersByName.get(name)?.folder ?? [])
      return [member.folder, targets.toSorted()] as const
    }),
  )

const cycleMessage = (cycle: Cycle): string => {
  const path = quotedList(cycle.path, " → ")
  const tangled = cycle.members.length > cycle.path.length - 1
  const group = tangled
    ? ` It is one of ${cycle.members.length} packages that each depend on all the others: ${quotedList(cycle.members, ", ")}.`
    : ""
  return `Depends on itself: ${path}.${group} Move what they share into a package they all use, or reverse a dependency.`
}

const isContractExports = (exports: unknown): boolean =>
  typeof exports === "object" &&
  exports !== null &&
  Object.keys(exports).length === 1 &&
  Object.getOwnPropertyDescriptor(exports, ".")?.value === "./src/index.ts"
