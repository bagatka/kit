# <package name>

One sentence: the capability this package provides, in terms a caller understands. The same
sentence is the `description` in its `package.json`, which npm shows and searches.

## Install

```sh
npm install <package name> effect
```

Its peer dependency, and where it runs: every runtime, or the platform object a caller passes.

## Use it

A short caller example of the normal case, and one consequential failure. Show what a caller writes,
not how the package works.

```ts
```

## Owns

- **Rules:** the decisions only this package makes.
- **Integrations:** services it talks to, if any.

## Does not own

Things a reader might expect here that live elsewhere, and where they live.

## Contract

`src/index.ts`. In two or three sentences, describe what callers use it for. Don't list the exports;
the file does that.

## Depends on

`effect`, packages whose contracts this package uses and why, and what the caller passes from the
platform.

## Settings

The values its layer takes, and which of them differ between deployments.

## Decisions and constraints

Non-obvious choices, the standards it follows, the limits it keeps on hostile input, and
constraints a future change must respect.

Delete the sections that don't apply.
