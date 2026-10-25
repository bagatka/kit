# kit

Small, general packages for building products with [Effect](https://effect.website) 4, on Cloudflare
Workers, in browsers, and anywhere else JavaScript runs. Each does one thing, with a contract that
fits on one screen.

## Packages

### Anywhere JavaScript runs

Workers, browsers, Deno, Bun and Node.

| Package | What it does |
|---|---|
| [`@bagatka/jwt`](packages/jwt) | Signs JSON Web Tokens with ES256 and RS256 keys, such as Apple's `.p8` keys and a GitHub App's |
| [`@bagatka/webauthn`](packages/webauthn) | Passkeys for a site: options to register and sign in, and checks of what a device answers |
| [`@bagatka/scrub`](packages/scrub) | Removes credentials and personal data from text before it is stored |
| [`@bagatka/qr-code`](packages/qr-code) | Encodes text as a QR code, such as a link a phone's camera opens, and draws it as SVG |
| [`@bagatka/quantile-sketch`](packages/quantile-sketch) | Quantiles such as p50 and p99 of any number of values, from small sketches that merge |
| [`@bagatka/otlp-protobuf`](packages/otlp-protobuf) | Reads and writes OpenTelemetry's OTLP/HTTP exports of traces and logs |

### Calling a service

Anywhere JavaScript runs, with the service's credentials. Each behaves the same way for retries,
errors and tracing.

| Package | What it does |
|---|---|
| [`@bagatka/apns`](packages/apns) | Sends push notifications to Apple devices through APNs, every push type |
| [`@bagatka/app-store-connect`](packages/app-store-connect) | Follows and publishes an app's releases through the App Store Connect API, on any Apple platform |
| [`@bagatka/github-app`](packages/github-app) | A GitHub App: its installations and their tokens, its creation from a manifest, and its webhooks' signatures |

### Cloudflare Workers only

On a binding only a Worker has.

| Package | What it does |
|---|---|
| [`@bagatka/ai-cloudflare-binding`](packages/ai-cloudflare-binding) | Effect AI from a Cloudflare Worker through its AI binding, with no API token: `LanguageModel` on Workers AI (text, streamed text, structured output), and Clef's decisions for `@effect/ai-cloudflare` |

### In builds and checks

In a build script on Bun, Node or Deno.

| Package | What it does |
|---|---|
| [`@bagatka/openapi-swift`](packages/openapi-swift) | Writes a typed Swift client of an HTTP API from its OpenAPI 3.1 document, such as Effect's `HttpApi` writes |
| [`@bagatka/bun-workspace-rules`](packages/bun-workspace-rules) | Checks a Bun workspace's packages against rules for names, contracts, and dependencies |

None is on npm yet: each one's contract is being reviewed before its first version.

## What every package promises

- **One entry, one screen.** Everything a package offers is in its `src/index.ts`, with a doc comment
  on every export; nothing else is reachable.
- **Every runtime.** Packages compile without any platform's types, so none reaches a global some
  runtime lacks. What one needs from the platform, such as Web Crypto, you pass in, and each release
  is type-checked against the DOM's and Cloudflare Workers' own types.
- **What Effect doesn't have, built on what it does.** Each package adds what Effect doesn't have
  built in, and uses Effect's own wherever Effect has it. `effect` is the only dependency besides
  the toolkit's own packages, such as `jwt` for the tokens `apns` signs, and Effect's own
  `@effect/ai-cloudflare`, whose client `ai-cloudflare-binding` provides; Effect's are peers, so your
  program has one copy.
- **Hostile input is normal input.** Nothing throws or hangs on what a stranger sends, and reading
  it takes time linear in its size, which tests check with crafted worst cases.
- **Checked as you would install it.** Before a version is published, it is built, installed beside
  the others, imported in Node, and type-checked with every declaration, then published with npm's
  provenance, so you can see which commit built it.
- **Semver, with a changelog** for every version.

## Install

```sh
npm install @bagatka/jwt effect
```

Each package's README shows its use, its failures, and the decisions behind it.

## Working on kit

```sh
./dev            # a shell with the pinned Bun, Node, and npm (Nix)
bun install
bun run check    # types and Effect's diagnostics, lint, format, and every package built and installed
bun run test
```

`AGENTS.md` is how we build software, for people and agents alike; `ARCHITECTURE.md` is the map,
and `PATTERNS.md` the one way each recurring problem is solved here.

## License

MIT, © 2026 Aleksandr Bagatka.
