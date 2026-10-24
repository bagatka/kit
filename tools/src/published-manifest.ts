import { Result, Schema } from "effect"

const Dependencies = Schema.Record(Schema.String, Schema.String)

/** The fields of a package's own `package.json` that npm's is written from. */
export const SourceManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  sideEffects: Schema.optional(Schema.Boolean),
  dependencies: Schema.optional(Dependencies),
})
export type SourceManifest = typeof SourceManifest.Type

/**
 * The `package.json` npm gets for a package: what npm shows and searches (its description,
 * keywords, links), its built files, the license, where its source is (npm's provenance checks it
 * against the repository that publishes), and dependencies at exact versions, `effect` as a peer.
 */
export const PublishedManifest = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  keywords: Schema.Array(Schema.String),
  license: Schema.Literal("MIT"),
  author: Schema.String,
  homepage: Schema.String,
  bugs: Schema.String,
  repository: Schema.Struct({ type: Schema.Literal("git"), url: Schema.String, directory: Schema.String }),
  type: Schema.Literal("module"),
  sideEffects: Schema.optional(Schema.Boolean),
  exports: Schema.Struct({
    ".": Schema.Struct({ types: Schema.Literal("./dist/index.d.ts"), default: Schema.Literal("./dist/index.js") }),
  }),
  dependencies: Schema.optional(Dependencies),
  peerDependencies: Schema.optional(Dependencies),
})
export type PublishedManifest = typeof PublishedManifest.Type

/** The repository every package's source is in, as npm's provenance expects it. */
export const repository = "bagatka/kit"
const repositoryUrl = `git+https://github.com/${repository}.git`

// Packages the caller's program must share one copy of, so they are peer dependencies: Effect's
// services, Schemas and errors are told apart by identity, and two copies of `effect` don't mix;
// nor do two of an Effect package whose services a package provides, such as `@effect/ai-cloudflare`.
// The range is the catalog's version and its later patches: Effect may change a module it marks
// unstable in a minor version (PATTERNS.md, "Versions").
const sharedWithCaller: ReadonlySet<string> = new Set(["effect", "@effect/ai-cloudflare"])

// A version npm takes as `latest`; a prerelease would need a dist-tag, which nothing here sets.
const exactVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** Whether `version` is one a package may have: `MAJOR.MINOR.PATCH`, such as `0.1.0`. */
export const isPublishableVersion = (version: string): boolean => exactVersion.test(version)

/**
 * The `package.json` npm gets for the package in `folder`, written from its own: each
 * `workspace:*` dependency at that package's version, each `catalog:` one at the catalog's, and
 * `effect` as a peer dependency. Fails with what keeps it from being published, each problem a
 * sentence: no version, description or keywords, a dependency npm can't have, or a range other than
 * those two.
 */
export const publishedManifest = (
  source: SourceManifest,
  context: {
    /** The package's folder from the repository's root: `packages/jwt`. */
    readonly folder: string
    /** Every package's name and version, for the packages it depends on. */
    readonly packageVersions: ReadonlyMap<string, string>
    /** The root `package.json`'s catalog: the one exact version of each npm dependency. */
    readonly catalog: Readonly<Record<string, string>>
  },
): Result.Result<PublishedManifest, ReadonlyArray<string>> => {
  const problems: Array<string> = []
  const version = source.version ?? ""
  if (source.version === undefined) {
    problems.push(`Has no version. Give it one: "0.1.0" before its first publish (PATTERNS.md, "Versions").`)
  } else if (!isPublishableVersion(version)) {
    problems.push(`Has version "${version}". Give one MAJOR.MINOR.PATCH, such as "0.1.0".`)
  }
  const description = source.description ?? ""
  if (description.length === 0) {
    problems.push("Has no description, which npm shows and searches. Give the README's first sentence.")
  }
  const keywords = source.keywords ?? []
  if (keywords.length === 0) {
    problems.push("Has no keywords, which npm searches. Give the words people search for it by.")
  }

  // Pairs, made into objects at the end with `Object.fromEntries`, which keeps every name an own
  // property, `__proto__` included; and catalog lookups by own property only, so a name like
  // `constructor` never resolves through Object.prototype.
  const dependencies: Array<readonly [string, string]> = []
  const peerDependencies: Array<readonly [string, string]> = []
  for (const [name, specifier] of Object.entries(source.dependencies ?? {})) {
    const packageVersion = context.packageVersions.get(name)
    const catalogVersion = Object.hasOwn(context.catalog, name) ? context.catalog[name] : undefined
    if (specifier === "workspace:*" && packageVersion !== undefined) {
      dependencies.push([name, packageVersion])
    } else if (specifier === "workspace:*") {
      problems.push(`Depends on ${name}, which isn't a package with a version, so npm can't have it.`)
    } else if (specifier === "catalog:" && catalogVersion !== undefined && sharedWithCaller.has(name)) {
      peerDependencies.push([name, `~${catalogVersion}`])
    } else if (specifier === "catalog:" && catalogVersion !== undefined) {
      dependencies.push([name, catalogVersion])
    } else if (specifier === "catalog:") {
      problems.push(`Depends on ${name} from the catalog, which has no version of it.`)
    } else {
      problems.push(
        `Depends on ${name} as "${specifier}". Give "workspace:*" or "catalog:", which have exact versions.`,
      )
    }
  }

  if (problems.length > 0) {
    return Result.fail(problems)
  }
  return Result.succeed({
    name: source.name,
    version,
    description,
    keywords,
    license: "MIT",
    author: "Aleksandr Bagatka",
    homepage: `https://github.com/${repository}/tree/main/${context.folder}#readme`,
    bugs: `https://github.com/${repository}/issues`,
    repository: { type: "git", url: repositoryUrl, directory: context.folder },
    type: "module",
    ...(source.sideEffects === undefined ? {} : { sideEffects: source.sideEffects }),
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    ...(dependencies.length === 0 ? {} : { dependencies: Object.fromEntries(dependencies) }),
    ...(peerDependencies.length === 0 ? {} : { peerDependencies: Object.fromEntries(peerDependencies) }),
  })
}
