# Architecture

`bagatka/kit` is a workspace of small, independent packages, each published to npm as
`@bagatka/<name>`, and the repository's own program, which checks and builds them. Nothing here is
an application: every package is a capability that products compose with a little glue of their
own.

## Parts

| Part | Purpose | Contract |
|---|---|---|
| `packages/apns` | Sends push notifications to Apple devices through APNs, signing with `jwt` | `packages/apns/src/index.ts` |
| `packages/app-store-connect` | Follows and publishes an app's releases through the App Store Connect API, signing with `jwt` | `packages/app-store-connect/src/index.ts` |
| `packages/github-app` | A GitHub App: its installations and their tokens, its manifest flow, its webhooks, signing with `jwt` | `packages/github-app/src/index.ts` |
| `packages/jwt` | Signs JWTs with ES256 and RS256 keys through Web Crypto | `packages/jwt/src/index.ts` |
| `packages/webauthn` | Passkeys: registration and authentication options, and checks of the answers | `packages/webauthn/src/index.ts` |
| `packages/openapi-swift` | Writes a typed Swift client from an OpenAPI 3.1 document | `packages/openapi-swift/src/index.ts` |
| `packages/otlp-protobuf` | Reads and writes OTLP/HTTP protobuf exports of traces and logs | `packages/otlp-protobuf/src/index.ts` |
| `packages/qr-code` | Encodes text as a QR code and draws it as SVG path data | `packages/qr-code/src/index.ts` |
| `packages/quantile-sketch` | Quantiles of any number of values from small sketches that merge | `packages/quantile-sketch/src/index.ts` |
| `packages/scrub` | Removes credentials and personal data from text before it is stored | `packages/scrub/src/index.ts` |
| `packages/ai-cloudflare-binding` | Effect AI from a Cloudflare Worker through its AI binding: `LanguageModel` on Workers AI, and Clef's decisions for `@effect/ai-cloudflare` | `packages/ai-cloudflare-binding/src/index.ts` |
| `packages/bun-workspace-rules` | Checks a Bun workspace's packages against rules for names, contracts and dependencies | `packages/bun-workspace-rules/src/index.ts` |
| `tools` | The repository's program: `bun run check`, `bun run check:swift`, `bun run test` and `bun run build` | none: it is a host |

## Dependency rules

Checked by `bun run check` from `tools/src/workspace-rules.ts`; a change to one is a change to both.

| Folder | Named | May use | May install | For development only |
|---|---|---|---|---|
| `packages/ai-cloudflare-binding` | `@bagatka/<folder>` | `packages/*` | `effect`, `@effect/ai-cloudflare` | `@effect/platform-browser`, `@effect/vitest`, `vitest` |
| `packages/*` | `@bagatka/<folder>` | `packages/*` | `effect` | `@effect/platform-browser`, `@effect/vitest`, `vitest` |
| `tools` | `kit-tools` | `packages/*` | `effect`, `@effect/platform-bun` | `@cloudflare/workers-types`, `@effect/platform-browser`, `@effect/vitest`, `vitest` |

- **A package depends on `effect` and on other packages here, nothing else,** but for an Effect
  package whose services it provides: `ai-cloudflare-binding` provides `@effect/ai-cloudflare`'s
  client, as a peer, so a program has one copy. A package that would need another npm dependency
  is a design discussion first (`AGENTS.md`, section 3).
- **Packages don't depend on each other unless one is built on the other's contract,** such as
  `apns`, `app-store-connect` and `github-app` on `jwt` for their tokens.
- **No cycles,** which the workspace rules check.

## How a package reaches npm

Inside the repository, packages import each other's `src/index.ts`, so a change is seen everywhere
at once and nothing is built while working. `bun run build` writes what npm gets: for each package,
JavaScript, declarations and their maps from `src/`, `src/` itself, its README and CHANGELOG, the
repository's LICENSE, and a `package.json` with exact versions and `effect` as a peer; then packs
it into the tarball `npm publish` takes. The check installs those tarballs side by side, imports
them in Node, and type-checks a program that uses them with the DOM's types and with Cloudflare
Workers', so a package that would break for a stranger fails here first.
`.github/workflows/publish.yml` publishes each `name@version` npm doesn't have, from a job that
installs only npm and can publish only from `main`, in the `npm` environment.

## Platforms

Packages compile with no platform's types (`tsconfig.base.json`, `"types": []`), so they can't
reach a global that some runtime lacks. What they need from the platform, such as Web Crypto, the
caller passes, typed structurally by the package; `tools/src/platform-types.ts` lists each such type,
and the check proves that the DOM's and Workers' objects fit it.

## Open decisions

- **Swift packages.** The toolkit's Swift packages will share this repository, with one
  `Package.swift` at its root and one product each, tagged `<major>.<minor>.<patch>` for Swift
  Package Manager; npm's versions are per package and never take such tags.
- **The shared core's check.** Products copy the core of `AGENTS.md` from here; the check that
  compares a copy with this one, and where it reads this one from, is still to be built.
