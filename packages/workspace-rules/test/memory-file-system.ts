import { Brand, Effect, FileSystem, Option, PlatformError } from "effect"

/**
 * What a path holds: a file's text; a symbolic link to another absolute, normalized path; or a file
 * or folder the reader may not read, which stat sees, but reading it, listing it, or going through
 * it fails with `PermissionDenied`.
 */
export type MemoryEntry = string | { readonly link: string } | { readonly denied: true }

// The most links one path may follow before it is a loop, as on Linux.
const maximumLinks = 40

const size = Brand.nominal<FileSystem.File.Info["size"]>()

const info = (type: FileSystem.File.Type, bytes: number): FileSystem.File.Info => ({
  type,
  mtime: Option.none(),
  atime: Option.none(),
  birthtime: Option.none(),
  dev: 1n,
  ino: Option.none(),
  mode: 0o644,
  nlink: Option.none(),
  uid: Option.none(),
  gid: Option.none(),
  rdev: Option.none(),
  size: size(BigInt(bytes)),
  blksize: Option.none(),
  blocks: Option.none(),
})

const failure = (tag: PlatformError.SystemErrorTag, method: string, path: string) =>
  Effect.fail(PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: path }))

const segmentsOf = (path: string) => path.split("/").filter((segment) => segment !== "")

const isLink = (entry: MemoryEntry | undefined): entry is { readonly link: string } =>
  typeof entry === "object" && "link" in entry

/**
 * A read-only file system holding `entries`, keyed by absolute path. Folders exist when an entry is
 * in them. Like Node's: `stat` and reads follow links, `readLink` reads one, a path through a file
 * fails with `BadResource` (ENOTDIR), and so does a loop of links (ELOOP). Enough for code that
 * reads with `readLink`, `stat`, `readFileString`, and `readDirectory` (not recursive).
 */
export const memoryFileSystem = (entries: Readonly<Record<string, MemoryEntry>>) => {
  // Each folder's names, so every lookup costs the path's depth, however many entries there are.
  const folders = new Map<string, Set<string>>()
  for (const path of Object.keys(entries)) {
    const segments = segmentsOf(path)
    segments.forEach((segment, index) => {
      const folder = `/${segments.slice(0, index).join("/")}`
      const names = folders.get(folder) ?? new Set<string>()
      names.add(segment)
      folders.set(folder, names)
    })
  }
  const entryAt = (path: string) => (Object.hasOwn(entries, path) ? entries[path] : undefined)

  // The real path and what is there, following links: a file's text or `undefined` for a folder,
  // and whether it may not be read.
  const resolve = (
    path: string,
    method: string,
  ): Effect.Effect<
    { readonly real: string; readonly text: string | undefined; readonly denied: boolean },
    PlatformError.PlatformError
  > => {
    let pending = segmentsOf(path)
    let real = ""
    let links = 0
    while (pending.length > 0) {
      const [segment = "", ...rest] = pending
      const next = `${real}/${segment}`
      const entry = entryAt(next)
      if (isLink(entry)) {
        links += 1
        if (links > maximumLinks) {
          return failure("BadResource", method, path)
        }
        pending = [...segmentsOf(entry.link), ...rest]
        real = ""
        continue
      }
      if (entry === undefined && !folders.has(next)) {
        return failure("NotFound", method, path)
      }
      if (typeof entry === "object" && rest.length > 0) {
        return failure("PermissionDenied", method, path)
      }
      if (typeof entry === "string" && rest.length > 0) {
        return failure("BadResource", method, path)
      }
      real = next
      pending = rest
    }
    const resolved = real === "" ? "/" : real
    const entry = entryAt(resolved)
    return Effect.succeed({
      real: resolved,
      text: typeof entry === "string" ? entry : undefined,
      denied: typeof entry === "object",
    })
  }

  return FileSystem.layerNoop({
    // The link at `path` itself, not followed; EINVAL (`Unknown`) when something else is there.
    readLink: (path) => {
      const entry = entryAt(path)
      if (isLink(entry)) {
        return Effect.succeed(entry.link)
      }
      return resolve(path, "readLink").pipe(Effect.flatMap(() => failure("Unknown", "readLink", path)))
    },
    stat: (path) =>
      resolve(path, "stat").pipe(
        Effect.map(({ real, text }) =>
          text === undefined && folders.has(real) ? info("Directory", 0) : info("File", text?.length ?? 0),
        ),
      ),
    readFileString: (path) =>
      resolve(path, "readFileString").pipe(
        Effect.flatMap(({ text, denied }) => {
          if (denied) {
            return failure("PermissionDenied", "readFileString", path)
          }
          return text === undefined ? failure("BadResource", "readFileString", path) : Effect.succeed(text)
        }),
      ),
    readDirectory: (path) =>
      resolve(path, "readDirectory").pipe(
        Effect.flatMap(({ real, text, denied }) => {
          if (denied) {
            return failure("PermissionDenied", "readDirectory", path)
          }
          return text === undefined
            ? Effect.succeed([...(folders.get(real) ?? [])].toSorted())
            : failure("BadResource", "readDirectory", path)
        }),
      ),
  })
}
