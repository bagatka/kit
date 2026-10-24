import { Schema } from "effect"

const Dependencies = Schema.Record(Schema.String, Schema.String)

// A field the rules don't support: any value of it is reported, so its shape doesn't matter.
const Unsupported = Schema.optional(Schema.Unknown)

/**
 * The fields of a `package.json` that the rules read; the others are ignored. Every key of a
 * dependency map is an own property, `__proto__` and `constructor` included.
 */
export const PackageJson = Schema.Struct({
  name: Schema.optional(Schema.String),
  exports: Schema.optional(Schema.Unknown),
  dependencies: Schema.optional(Dependencies),
  devDependencies: Schema.optional(Dependencies),
  optionalDependencies: Schema.optional(Dependencies),
  peerDependencies: Schema.optional(Dependencies),
  bundleDependencies: Unsupported,
  bundledDependencies: Unsupported,
  overrides: Unsupported,
  resolutions: Unsupported,
  patchedDependencies: Unsupported,
  trustedDependencies: Unsupported,
  catalog: Unsupported,
  catalogs: Unsupported,
  workspaces: Schema.optional(
    Schema.Union([
      Schema.Array(Schema.String),
      Schema.Struct({
        packages: Schema.Array(Schema.String),
        catalog: Schema.optional(Dependencies),
        catalogs: Unsupported,
      }),
    ]),
  ),
})
export type PackageJson = typeof PackageJson.Type

/** A `package.json` file's text, decoded. */
export const PackageJsonFromString = Schema.fromJsonString(PackageJson)
