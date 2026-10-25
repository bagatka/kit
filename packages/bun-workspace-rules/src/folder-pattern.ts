import { Option } from "effect"

/** A parsed folder pattern: the parent folders, and a test for the last segment. */
export interface FolderPattern {
  /** The folders before the last segment, joined with `/`: `packages` for `packages/*`. */
  readonly parent: string
  /** Whether the last segment has a `*`, so the pattern stands for every folder it matches. */
  readonly hasWildcard: boolean
  /** Whether a folder's last segment matches: any name for `*`, a prefix for `cloudflare-*`. */
  readonly matchesName: (name: string) => boolean
}

// A folder name these rules support: lowercase ASCII letters and digits, `.`, `_`, and `-`,
// starting with a letter or digit. No `..`, no empty name, nothing a terminal or a CI log reads.
const supportedName = /^[a-z0-9][a-z0-9._-]*$/

// The last segment of a `parent/*` pattern: `*`, or a supported name's start and `*`.
const wildcardName = /^(?:[a-z0-9][a-z0-9._-]*)?\*$/

/** Whether `name` is a folder name these rules support. */
export const isSupportedName = (name: string): boolean => supportedName.test(name)

/**
 * Parses `product/foundation`, `packages/*`, or `packages/cloudflare-*`: supported folder names,
 * the last of which may end with `*` when a parent comes before it. Anything else is `None`.
 */
export const parseFolderPattern = (pattern: string): Option.Option<FolderPattern> => {
  const segments = pattern.split("/")
  const parents = segments.slice(0, -1)
  const last = segments.at(-1) ?? ""
  const hasWildcard = wildcardName.test(last)
  const isSupported = parents.every(isSupportedName) && (isSupportedName(last) || (hasWildcard && parents.length > 0))
  if (!isSupported) {
    return Option.none()
  }
  const prefix = last.slice(0, -1)
  return Option.some({
    parent: parents.join("/"),
    hasWildcard,
    matchesName: (name) => (hasWildcard ? name.startsWith(prefix) : name === last),
  })
}

/** Whether `folder` (relative, written with `/`) matches `pattern`. An invalid pattern matches nothing. */
export const matchesFolder = (pattern: string, folder: string): boolean => {
  const slash = folder.lastIndexOf("/")
  const parent = slash === -1 ? "" : folder.slice(0, slash)
  return Option.exists(
    parseFolderPattern(pattern),
    (parsed) => parsed.parent === parent && parsed.matchesName(folder.slice(slash + 1)),
  )
}
