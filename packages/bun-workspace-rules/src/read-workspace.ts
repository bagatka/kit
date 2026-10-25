import { Effect, FileSystem, Option, Path, Schema } from "effect"
import type { PlatformError } from "effect"

import { findRepeatedKey } from "./find-repeated-key.ts"
import { isSupportedName, parseFolderPattern } from "./folder-pattern.ts"
import { PackageJsonFromString } from "./package-json.ts"
import type { PackageJson } from "./package-json.ts"
import { escaped, quoted } from "./printable-text.ts"
import { Violation } from "./violation.ts"
import { WorkspaceUnreadable } from "./workspace-unreadable.ts"

/** A workspace as the rules see it. Folders are relative to the root and written with `/`. */
export interface Workspace {
  /** The root `package.json`. */
  readonly root: PackageJson
  /** The root `package.json`'s `workspaces.catalog`: one version for each npm package. */
  readonly catalog: Readonly<Record<string, string>>
  /** Every workspace package, sorted by folder. */
  readonly members: ReadonlyArray<Member>
  /** What a `parent/*` folder holds that these rules don't support: links, and unsupported names. */
  readonly unsupported: ReadonlyArray<Violation>
}

/** A workspace package: a folder with a supported name and a `package.json`. */
export interface Member {
  /** Its folder, relative to the root. */
  readonly folder: string
  readonly manifest: PackageJson
  /** Whether `src/index.ts` is a regular file. */
  readonly hasEntry: boolean
}

// What a path holds, without following a link there: nothing, a link, or what stat says.
type Entry =
  | { readonly kind: "missing" }
  | { readonly kind: "link" }
  | { readonly kind: FileSystem.File.Type; readonly size: bigint }

// What the folders a pattern names hold: the packages, and what isn't supported.
interface Expanded {
  readonly members: ReadonlyArray<string>
  readonly unsupported: ReadonlyArray<Violation>
}

// 1 MiB. A real package.json is a few KiB; the limit bounds the memory a mistaken one takes.
const maximumManifestBytes = 1_048_576n

// Enough parallel reads to hide disk latency, few enough to stay far below open-file limits.
const concurrency = 16

// Nothing is at a path: it is missing, or goes through a file.
const isAbsent = (error: PlatformError.PlatformError) =>
  error.reason._tag === "NotFound" || error.reason._tag === "BadResource"

const failed = (path: string, doing: string) => (error: PlatformError.PlatformError) =>
  new WorkspaceUnreadable({ path: escaped(path), reason: `${doing} failed: ${escaped(error.message)}` })

const isLinkReason = "it is a link, and links aren't supported"

const unsupportedIn = (folder: string, message: string) => new Violation({ folder, check: "unsupported", message })

/** Reads the root `package.json`, the folders its workspace patterns name, and each package's `package.json`. */
export const readWorkspace = Effect.fnUntraced(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // `readLink` succeeds only on a link, so a link is found without following it; anything else
  // that `readLink` refuses is whatever `stat` says.
  const entryAt = Effect.fnUntraced(function* (relative: string): Effect.fn.Return<Entry, WorkspaceUnreadable> {
    const absolute = path.join(root, relative)
    const isLink = yield* fs.readLink(absolute).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    )
    if (isLink) {
      return { kind: "link" }
    }
    const info = yield* fs.stat(absolute).pipe(
      Effect.asSome,
      Effect.catchIf(isAbsent, () => Effect.succeedNone),
      Effect.mapError(failed(relative, "reading it")),
    )
    return Option.match(info, {
      onNone: (): Entry => ({ kind: "missing" }),
      onSome: (found): Entry => ({ kind: found.type, size: found.size }),
    })
  })

  const readManifest = Effect.fnUntraced(function* (file: string) {
    const entry = yield* entryAt(file)
    if (entry.kind === "missing") {
      return yield* new WorkspaceUnreadable({ path: file, reason: "it is missing" })
    }
    if (entry.kind !== "File") {
      return yield* new WorkspaceUnreadable({ path: file, reason: `it is a ${entry.kind}, not a regular file` })
    }
    if (entry.size > maximumManifestBytes) {
      return yield* new WorkspaceUnreadable({ path: file, reason: "it is larger than 1 MiB" })
    }
    const text = yield* fs.readFileString(path.join(root, file)).pipe(Effect.mapError(failed(file, "reading it")))
    const manifest = yield* Schema.decodeEffect(PackageJsonFromString)(text).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceUnreadable({ path: file, reason: `it isn't a valid package.json: ${escaped(error.message)}` }),
      ),
    )
    // Bun reads the first of two keys, JSON.parse the last; refusing both keeps the check reading
    // what Bun reads.
    const repeated = yield* findRepeatedKey(text)
    if (repeated._tag === "Some") {
      return yield* new WorkspaceUnreadable({
        path: file,
        reason: `it has the key ${quoted(repeated.value)} twice in one object, and package managers disagree on which one counts. Keep one.`,
      })
    }
    return manifest
  })

  const holdsManifest = Effect.fnUntraced(function* (folder: string) {
    const manifest = yield* entryAt(`${folder}/package.json`)
    return manifest.kind !== "missing"
  })

  const expand = Effect.fnUntraced(function* (pattern: string): Effect.fn.Return<Expanded, WorkspaceUnreadable> {
    const parsed = parseFolderPattern(pattern)
    if (parsed._tag === "None") {
      return yield* new WorkspaceUnreadable({
        path: "package.json",
        reason: `the workspace pattern ${quoted(pattern)} isn't supported: a folder, or "parent/*", whose folder names are lowercase letters, digits, ".", "_", and "-", starting with a letter or digit`,
      })
    }
    const { parent, hasWildcard, matchesName } = parsed.value
    // A folder named on its own is meant to be a package, so its absence is an error, not an empty match.
    if (!hasWildcard) {
      const folder = yield* entryAt(pattern)
      const hasManifest = yield* holdsManifest(pattern)
      if (folder.kind === "link") {
        return yield* new WorkspaceUnreadable({ path: pattern, reason: isLinkReason })
      }
      if (!hasManifest) {
        return yield* new WorkspaceUnreadable({
          path: pattern,
          reason: "the root package.json names it as a workspace, but it isn't a folder with a package.json",
        })
      }
      return { members: [pattern], unsupported: [] }
    }
    const parentFolder = yield* entryAt(parent)
    if (parentFolder.kind === "link") {
      return yield* new WorkspaceUnreadable({ path: parent, reason: isLinkReason })
    }
    // A parent that is missing, or not a folder, holds no packages yet.
    if (parentFolder.kind !== "Directory") {
      return { members: [], unsupported: [] }
    }
    const names = yield* fs.readDirectory(path.join(root, parent)).pipe(Effect.mapError(failed(parent, "listing it")))
    // Names starting with `.` (`.git`, `.DS_Store`) are never packages.
    const matched = names.filter((name) => matchesName(name) && !name.startsWith("."))
    const listed = yield* Effect.forEach(
      matched,
      (name) => entryAt(`${parent}/${name}`).pipe(Effect.map((entry) => ({ name, kind: entry.kind }))),
      { concurrency },
    )
    const unsupported = listed.flatMap(({ name, kind }) => {
      if (kind === "link") {
        return [
          unsupportedIn(
            parent,
            `Has ${quoted(name)}, a link, where ${pattern} finds packages: links aren't supported.`,
          ),
        ]
      }
      if (kind === "Directory" && !isSupportedName(name)) {
        return [
          unsupportedIn(
            parent,
            `Has the folder ${quoted(name)}, which ${pattern} matches, and folder names are lowercase letters, digits, ".", "_", and "-", starting with a letter or digit.`,
          ),
        ]
      }
      // Anything else that isn't a folder, such as a README.md, isn't a package.
      return []
    })
    const folders = listed
      .filter(({ name, kind }) => kind === "Directory" && isSupportedName(name))
      .map(({ name }) => `${parent}/${name}`)
    const members = yield* Effect.filter(folders, holdsManifest, { concurrency })
    return { members, unsupported }
  })

  const readMember = Effect.fnUntraced(function* (folder: string) {
    const manifest = yield* readManifest(`${folder}/package.json`)
    const entry = yield* entryAt(`${folder}/src/index.ts`)
    return { folder, manifest, hasEntry: entry.kind === "File" } satisfies Member
  })

  const rootManifest = yield* readManifest("package.json")
  const workspaces = rootManifest.workspaces
  if (workspaces === undefined) {
    return yield* new WorkspaceUnreadable({ path: "package.json", reason: "it has no workspaces" })
  }
  // Bun reads `workspaces` as a list of patterns, or as an object with the list and a catalog.
  const patterns = "packages" in workspaces ? workspaces.packages : workspaces
  const catalog = "packages" in workspaces ? (workspaces.catalog ?? {}) : {}

  // A pattern listed twice is read once.
  // Not handled: many different `parent/*` patterns over one large folder each list and match the
  // whole folder, so time grows with patterns times entries. A real workspace lists a handful.
  const expanded = yield* Effect.forEach(new Set(patterns), expand)
  const folders = [...new Set(expanded.flatMap((each) => each.members))].toSorted()
  const members = yield* Effect.forEach(folders, readMember, { concurrency })
  const unsupported = expanded.flatMap((each) => each.unsupported)
  return { root: rootManifest, catalog, members, unsupported } satisfies Workspace
})
