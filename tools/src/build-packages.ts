import { Effect, FileSystem, Order, Path, Result, Schema } from "effect"

import { platformProgram, platformTypes } from "./platform-types.ts"
import { isPublishableVersion, PublishedManifest, publishedManifest, SourceManifest } from "./published-manifest.ts"
import { runToEnd } from "./run-to-end.ts"

/** A package as npm gets it. */
export interface BuiltPackage {
  readonly name: string
  readonly version: string
  /**
   * The tarball `npm publish` takes, the very bytes the check installed and type-checked:
   * `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE`, `dist/`, and `src/`.
   */
  readonly tarball: string
}

/**
 * What `buildPackages` made: every package, dependencies before the packages that use them, which
 * is the order to publish them in; and what keeps any from being published, each a sentence that
 * starts with the package's folder. Publish nothing unless `problems` is empty.
 */
export interface Built {
  readonly packages: ReadonlyArray<BuiltPackage>
  readonly problems: ReadonlyArray<string>
}

const packagesFolder = "packages"

// The type checker runs several threads of its own, so a few builds at a time use the machine.
const buildsAtOnce = 4

const RootManifest = Schema.fromJsonString(
  Schema.Struct({ workspaces: Schema.Struct({ catalog: Schema.Record(Schema.String, Schema.String) }) }),
)
const SourceManifestText = Schema.fromJsonString(SourceManifest)
const PublishedManifestText = Schema.fromJsonString(PublishedManifest, { space: 2 })
const JsonText = Schema.fromJsonString(Schema.Unknown, { space: 2 })

/** Plain data as JSON text: the files written for the type checker. */
const jsonText = (value: unknown) => Schema.encodeEffect(JsonText)(value).pipe(Effect.orDie)

interface Source {
  /** The package's folder's own name, which its published name ends in: `jwt`. */
  readonly directory: string
  readonly manifest: SourceManifest
}

/** Every package's folder name and `package.json`, by folder name. */
const readSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(packagesFolder).pipe(Effect.orDie)
  const sources: Array<Source> = []
  for (const directory of entries.toSorted(Order.String)) {
    const file = path.join(packagesFolder, directory, "package.json")
    const isPackage = yield* fs.exists(file).pipe(Effect.orDie)
    if (isPackage) {
      const text = yield* fs.readFileString(file).pipe(Effect.orDie)
      // The workspace rules read the same file first, and report one that isn't JSON.
      const manifest = yield* Schema.decodeEffect(SourceManifestText)(text).pipe(Effect.orDie)
      sources.push({ directory, manifest })
    }
  }
  return sources
})

/**
 * The files of a package's `src/`, relative to it, once each is a TypeScript file of its own: a
 * symbolic link, which could lead anywhere, or any other file, such as a stray `.env`, is a problem,
 * so nothing but the package's source reaches npm.
 */
const sourceFiles = Effect.fn("sourceFiles")(function* (sourceRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(sourceRoot, { recursive: true })
  const files: Array<string> = []
  const problems: Array<string> = []
  for (const entry of entries.toSorted(Order.String)) {
    const file = path.join(sourceRoot, entry)
    const link = yield* fs.readLink(file).pipe(Effect.option)
    const info = yield* fs.stat(file)
    if (link._tag === "Some") {
      problems.push(`src/${entry} is a symbolic link. Only TypeScript files of its own may be in src/.`)
    } else if (info.type === "File" && entry.endsWith(".ts")) {
      files.push(entry)
    } else if (info.type !== "Directory") {
      problems.push(`src/${entry} isn't a TypeScript file, and npm would publish it. Move it out of src/.`)
    }
  }
  return { files, problems }
}, Effect.orDie)

// A source map as the type checker writes it.
const SourceMap = Schema.Struct({
  version: Schema.Int,
  file: Schema.String,
  sourceRoot: Schema.optional(Schema.String),
  sources: Schema.Array(Schema.String),
  names: Schema.Array(Schema.String),
  mappings: Schema.String,
})
const SourceMapText = Schema.fromJsonString(SourceMap)

/**
 * Points every map in `dist/` at the package's own copy of its source, `src/`, which npm publishes
 * beside it: the type checker writes paths to where it compiled from, which are the repository's,
 * or this machine's. Returns the maps whose sources aren't in the package's `src/`.
 */
const pointMapsAtSource = Effect.fn("pointMapsAtSource")(function* (target: string, sourceRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dist = path.join(target, "dist")
  const entries = yield* fs.readDirectory(dist, { recursive: true })
  const problems: Array<string> = []
  for (const entry of entries.filter((name) => name.endsWith(".map")).toSorted(Order.String)) {
    const mapFile = path.join(dist, entry)
    const text = yield* fs.readFileString(mapFile)
    const map = yield* Schema.decodeEffect(SourceMapText)(text)
    const sources: Array<string> = []
    for (const source of map.sources) {
      const compiledFrom = path.resolve(path.dirname(mapFile), map.sourceRoot ?? "", source)
      const inSource = path.relative(sourceRoot, compiledFrom)
      const shipped = path.join(target, "src", inSource)
      const exists = yield* fs.exists(shipped)
      if (inSource.startsWith("..") || path.isAbsolute(inSource) || !exists) {
        problems.push(`dist/${entry} maps to ${source}, which isn't in the package's src/.`)
      }
      sources.push(path.relative(path.dirname(mapFile), shipped))
    }
    const rewritten = yield* Schema.encodeEffect(SourceMapText)({ ...map, sourceRoot: "", sources })
    yield* fs.writeFileString(mapFile, rewritten)
  }
  return problems
}, Effect.orDie)

// What `npm pack --json` says it packed.
const PackedText = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ filename: Schema.String, files: Schema.Array(Schema.Struct({ path: Schema.String })) })),
)

// The only files a package's tarball may hold.
const publishable =
  /^(package\.json|README\.md|CHANGELOG\.md|LICENSE|src\/[a-z0-9/-]+\.ts|dist\/[a-z0-9/-]+\.(js|d\.ts)(\.map)?)$/

/**
 * Packs the built package in `target` into a tarball in `tarballs`, as `npm publish` would, and
 * checks that it holds only what a package may: returns the tarball, and what else it held.
 */
const pack = Effect.fn("pack")(function* (root: string, target: string, tarballs: string) {
  const path = yield* Path.Path
  const packed = yield* runToEnd("npm", ["pack", target, "--pack-destination", tarballs, "--json"], root)
  if (packed.exitCode !== 0) {
    return { tarball: undefined, problems: [`npm can't pack it:\n${packed.output}`] }
  }
  const [result] = yield* Schema.decodeEffect(PackedText)(packed.stdout).pipe(Effect.orDie)
  if (result === undefined) {
    return { tarball: undefined, problems: ["npm packed nothing."] }
  }
  const files = result.files.map((file) => file.path)
  const problems = [
    ...files
      .filter((file) => !publishable.test(file))
      .map((file) => `The tarball would hold ${file}, which no package publishes.`),
    ...["dist/index.js", "dist/index.d.ts", "package.json", "README.md", "CHANGELOG.md", "LICENSE"]
      .filter((file) => !files.includes(file))
      .map((file) => `The tarball has no ${file}.`),
  ]
  return { tarball: path.join(tarballs, result.filename), problems }
})

/** Whether `changelog` has an entry for `version`: a heading `## <version>`. */
const hasEntryFor = (changelog: string, version: string) =>
  changelog.split("\n").some((line) => line.trim() === `## ${version}`)

/**
 * Builds one package into `<out>/<directory>`: JavaScript, declarations and their maps from `src/`,
 * with the type checker and the package's own settings; `src/` itself, which the maps lead to; its
 * README and CHANGELOG, the repository's LICENSE, and the `package.json` npm gets. Returns what
 * went wrong, if anything.
 */
const buildOne = Effect.fn("buildOne")(function* (
  root: string,
  out: string,
  source: Source,
  manifest: Result.Result<PublishedManifest, ReadonlyArray<string>>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const folder = path.join(packagesFolder, source.directory)
  const sourceFolder = path.join(root, folder)
  const target = path.join(out, source.directory)
  const problems = Result.isFailure(manifest) ? [...manifest.failure] : []

  const sourceRoot = path.join(sourceFolder, "src")
  const sourceList = yield* sourceFiles(sourceRoot)
  problems.push(...sourceList.problems)

  // The package's own compiler settings, emitting: files keep their names, and `./x.ts` imports
  // become `./x.js` in the JavaScript (declarations keep `./x.ts`, which the type checker resolves).
  const config = path.join(out, ".build", `${source.directory}.tsconfig.json`)
  const configText = yield* jsonText({
    extends: path.join(sourceFolder, "tsconfig.json"),
    include: [sourceRoot],
    compilerOptions: {
      noEmit: false,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      rewriteRelativeImportExtensions: true,
      rootDir: sourceRoot,
      outDir: path.join(target, "dist"),
    },
  })
  yield* fs.writeFileString(config, configText).pipe(Effect.orDie)
  const compiled = yield* runToEnd(path.join(root, "node_modules", ".bin", "tsc"), ["-p", config], root)
  if (compiled.exitCode !== 0) {
    problems.push(`Doesn't compile:\n${compiled.output}`)
  }
  // Copied file by file, never a link, so the maps below lead to exactly the source that compiled.
  for (const file of sourceList.files) {
    const copy = path.join(target, "src", file)
    yield* fs.makeDirectory(path.dirname(copy), { recursive: true }).pipe(Effect.orDie)
    const bytes = yield* fs.readFile(path.join(sourceRoot, file)).pipe(Effect.orDie)
    yield* fs.writeFile(copy, bytes).pipe(Effect.orDie)
  }
  if (compiled.exitCode === 0) {
    problems.push(...(yield* pointMapsAtSource(target, sourceRoot)))
  }

  for (const file of ["README.md", "CHANGELOG.md"]) {
    const from = path.join(sourceFolder, file)
    const present = yield* fs.exists(from).pipe(Effect.orDie)
    if (present) {
      yield* fs.copyFile(from, path.join(target, file)).pipe(Effect.orDie)
    } else {
      problems.push(`Has no ${file}, which npm publishes with it.`)
    }
  }
  yield* fs.copyFile(path.join(root, "LICENSE"), path.join(target, "LICENSE")).pipe(Effect.orDie)

  const changelogFile = path.join(sourceFolder, "CHANGELOG.md")
  const hasChangelog = yield* fs.exists(changelogFile).pipe(Effect.orDie)
  const changelog = hasChangelog ? yield* fs.readFileString(changelogFile).pipe(Effect.orDie) : ""
  const version = source.manifest.version
  if (hasChangelog && version !== undefined && !hasEntryFor(changelog, version)) {
    problems.push(`CHANGELOG.md has no entry for ${version}. Add "## ${version}" and what changed in it.`)
  }

  if (Result.isSuccess(manifest)) {
    const text = yield* Schema.encodeEffect(PublishedManifestText)(manifest.success).pipe(Effect.orDie)
    yield* fs.writeFileString(path.join(target, "package.json"), `${text}\n`).pipe(Effect.orDie)
  }
  return problems.map((problem) => `${folder}: ${problem}`)
})

/**
 * Installs the packages' tarballs beside each other as npm would, with the npm packages they depend
 * on linked from the workspace; imports each in Node; and type-checks, declarations included, with
 * Node's module resolution, a program that imports them all, and the platform types against the
 * DOM's types and against Cloudflare Workers'. Returns what went wrong.
 */
const checkInstalled = Effect.fn("checkInstalled")(function* (
  root: string,
  out: string,
  built: ReadonlyArray<{ readonly source: Source; readonly manifest: PublishedManifest; readonly tarball: string }>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const modules = path.join(out, "node_modules")
  yield* fs.makeDirectory(path.join(modules, "@bagatka"), { recursive: true }).pipe(Effect.orDie)

  const linked = new Set<string>()
  const link = Effect.fnUntraced(function* (name: string, installedIn: string) {
    const installed = yield* fs.realPath(path.join(installedIn, "node_modules", name))
    yield* fs.makeDirectory(path.dirname(path.join(modules, name)), { recursive: true })
    yield* fs.symlink(installed, path.join(modules, name))
    linked.add(name)
  }, Effect.orDie)
  const problems: Array<string> = []
  for (const { source, manifest, tarball } of built) {
    // The tarball itself, unpacked as npm installs it: its files are under `package/`.
    const installed = path.join(modules, manifest.name)
    yield* fs.makeDirectory(installed, { recursive: true }).pipe(Effect.orDie)
    const unpacked = yield* runToEnd("tar", ["-xzf", tarball, "-C", installed, "--strip-components", "1"], root)
    if (unpacked.exitCode !== 0) {
      problems.push(`${packagesFolder}/${source.directory}: Its tarball doesn't unpack:\n${unpacked.output}`)
    }
    const external = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }).filter(
      (name) => !built.some((other) => other.manifest.name === name) && !linked.has(name),
    )
    for (const name of external) {
      // The package's own install of it, at the catalog's version.
      yield* link(name, path.join(root, packagesFolder, source.directory))
    }
  }
  yield* link("@cloudflare/workers-types", path.join(root, "tools"))

  const probes = path.join(out, ".build")
  const names = built.map(({ manifest }) => manifest.name)
  yield* fs.writeFileString(path.join(probes, "package.json"), `{ "type": "module" }\n`).pipe(Effect.orDie)
  const imports = names.map((name) => `await import("${name}")`).join("\n")
  yield* fs.writeFileString(path.join(probes, "import.js"), `${imports}\n`).pipe(Effect.orDie)
  const declarations = names.map((name, index) => `import * as package${index} from "${name}"`).join("\n")
  const all = `export const packages = [${names.map((_, index) => `package${index}`).join(", ")}]`
  yield* fs.writeFileString(path.join(probes, "packages.ts"), `${declarations}\n${all}\n`).pipe(Effect.orDie)
  const used = platformTypes.filter((type) => names.includes(type.packageName))
  yield* fs.writeFileString(path.join(probes, "platform.ts"), platformProgram(used, false)).pipe(Effect.orDie)
  const workersOnly = platformProgram(used, true)
  yield* fs.writeFileString(path.join(probes, "platform-workers.ts"), workersOnly).pipe(Effect.orDie)

  const compilerOptions = {
    module: "nodenext",
    target: "es2024",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
  }
  // `effect`'s own declarations name the Web's types, such as URL and ReadableStream, which a
  // program gets from the DOM's library or from its platform's types.
  const browser = yield* jsonText({
    compilerOptions: { ...compilerOptions, lib: ["esnext", "dom", "dom.iterable"], types: [] },
    files: ["packages.ts", "platform.ts"],
  })
  yield* fs.writeFileString(path.join(probes, "tsconfig.browser.json"), browser).pipe(Effect.orDie)
  // Effect's own declarations also name the DOM's `Storage`, which Workers don't have, so with
  // Workers' types only the program is checked, not the declarations it reads; the DOM's check
  // reads every declaration.
  const workers = yield* jsonText({
    compilerOptions: { ...compilerOptions, lib: ["esnext"], types: ["@cloudflare/workers-types"], skipLibCheck: true },
    files: ["packages.ts", "platform.ts", "platform-workers.ts"],
  })
  yield* fs.writeFileString(path.join(probes, "tsconfig.workers.json"), workers).pipe(Effect.orDie)

  const imported = yield* runToEnd("node", ["import.js"], probes)
  if (imported.exitCode !== 0) {
    problems.push(`${packagesFolder}: The built packages don't import in Node:\n${imported.output}`)
  }
  const tsc = path.join(root, "node_modules", ".bin", "tsc")
  for (const [platformName, config] of [
    ["the DOM's", "tsconfig.browser.json"],
    ["Cloudflare Workers'", "tsconfig.workers.json"],
  ] as const) {
    const checked = yield* runToEnd(tsc, ["-p", config], probes)
    if (checked.exitCode !== 0) {
      problems.push(
        `${packagesFolder}: The built packages don't type-check with ${platformName} types:\n${checked.output}`,
      )
    }
  }
  return problems
})

/**
 * `items` with each one after the items it depends on, by name; among those ready at once, in their
 * given order. Fails with the items left over when some depend on each other.
 */
const dependenciesFirst = <A extends { readonly name: string; readonly dependsOn: ReadonlyArray<string> }>(
  items: ReadonlyArray<A>,
): Result.Result<ReadonlyArray<A>, ReadonlyArray<A>> => {
  const names = new Set(items.map((item) => item.name))
  const ordered: Array<A> = []
  const placed = new Set<string>()
  while (ordered.length < items.length) {
    const ready = items.filter(
      (item) =>
        !placed.has(item.name) &&
        item.dependsOn.every((dependency) => placed.has(dependency) || !names.has(dependency)),
    )
    if (ready.length === 0) {
      return Result.fail(items.filter((item) => !placed.has(item.name)))
    }
    for (const item of ready) {
      ordered.push(item)
      placed.add(item.name)
    }
  }
  return Result.succeed(ordered)
}

/**
 * Builds every package as npm gets it, each into a folder of its own in `out`, an empty folder given
 * as an absolute path, and checks that they install, import and type-check together. `out` also
 * holds what checking needs: `node_modules` and `.build`. Run it from the repository's root, in the
 * toolchain: it runs the type checker and Node.
 */
export const buildPackages = Effect.fn("buildPackages")(function* (out: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.resolve(".")
  const rootText = yield* fs.readFileString("package.json").pipe(Effect.orDie)
  const rootManifest = yield* Schema.decodeEffect(RootManifest)(rootText).pipe(Effect.orDie)
  const catalog = rootManifest.workspaces.catalog
  const sources = yield* readSources

  const packageVersions = new Map(
    sources.flatMap(({ manifest }) =>
      manifest.version !== undefined && isPublishableVersion(manifest.version)
        ? [[manifest.name, manifest.version] as const]
        : [],
    ),
  )
  const planned = sources.map((source) => ({
    source,
    manifest: publishedManifest(source.manifest, {
      folder: path.join(packagesFolder, source.directory),
      packageVersions,
      catalog,
    }),
  }))

  yield* fs.makeDirectory(path.join(out, ".build"), { recursive: true }).pipe(Effect.orDie)
  const buildProblems = yield* Effect.forEach(
    planned,
    ({ source, manifest }) => buildOne(root, out, source, manifest),
    { concurrency: buildsAtOnce },
  )
  const problems = buildProblems.flat()

  if (problems.length > 0) {
    return { packages: [], problems } satisfies Built
  }

  const tarballs = path.join(out, "tarballs")
  yield* fs.makeDirectory(tarballs, { recursive: true }).pipe(Effect.orDie)
  const built: Array<{
    readonly source: Source
    readonly manifest: PublishedManifest
    readonly tarball: string
    readonly name: string
    readonly dependsOn: ReadonlyArray<string>
  }> = []
  for (const { source, manifest } of planned) {
    const packed = yield* pack(root, path.join(out, source.directory), tarballs)
    problems.push(...packed.problems.map((problem) => `${packagesFolder}/${source.directory}: ${problem}`))
    if (Result.isSuccess(manifest) && packed.tarball !== undefined) {
      built.push({
        source,
        manifest: manifest.success,
        tarball: packed.tarball,
        name: manifest.success.name,
        dependsOn: Object.keys(manifest.success.dependencies ?? {}),
      })
    }
  }
  const ordered = dependenciesFirst(built)
  if (Result.isFailure(ordered)) {
    const tangled = ordered.failure.map((item) => item.name).join(", ")
    problems.push(`${packagesFolder}: ${tangled} depend on each other; the workspace rules name the cycle.`)
  }
  if (problems.length > 0) {
    return { packages: [], problems } satisfies Built
  }

  const installProblems = yield* checkInstalled(root, out, built)
  if (installProblems.length > 0) {
    return { packages: [], problems: installProblems } satisfies Built
  }
  const inOrder = Result.isSuccess(ordered) ? ordered.success : []
  return {
    packages: inOrder.map(({ manifest, tarball }) => ({
      name: manifest.name,
      version: manifest.version,
      tarball,
    })),
    problems: [],
  } satisfies Built
})
