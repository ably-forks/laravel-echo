# Contributing

Thank you for your interest in contributing to Laravel Echo! Your contributions help make this project better for everyone.

Echo is maintained as a monorepo using [pnpm workspaces](https://pnpm.io/workspaces). Below you'll find an overview of the repository and how to get your development environment running.

> **Note:** You'll need **pnpm version 12 or higher**. If you're unsure which version you have, run `pnpm -v`.

**Prerequisites (this fork):** use Node 24.11 or later in the 24 line (see `.nvmrc`), Node 22.18 or later in the 22 line, or Node 26 or later (the Vite+ range `^22.18.0 || ^24.11.0 || >=26.0.0`, also in the root `engines`), and pnpm 12.3.4, which the root `packageManager` field pins. Get pnpm through corepack 0.34.5 or later, because older corepack releases, such as the 0.34.0 bundled with Node 22.19, cannot start pnpm 11 or later: run `npm i -g corepack@latest`, then `corepack enable`. Or install pnpm directly with `npm i -g pnpm@12.3.4`. Do not work around a version mismatch with `npm_config_manage_package_manager_versions=false`. Projects that use the published packages need only Node 22 or later. This repository is Ably's fork of Laravel Echo: the `2.x` branch holds `@ably/laravel-echo` 2.x and its React, Vue and Svelte packages, synced with upstream `laravel/echo` 2.x.

## Repository Overview

```
echo/
├── packages/
│   ├── laravel-echo/    Core library
│   ├── react/           React hooks
│   │   └── tests/       React tests
│   ├── svelte/          Svelte runes
│   │   └── tests/       Svelte tests
│   └── vue/             Vue hooks
│       └── tests/       Vue Tests
```

## Getting Started

Clone the repository and install the dependencies:

```sh
git clone -b 2.x https://github.com/ably-forks/laravel-echo.git echo
cd echo
pnpm install
```

Then, start the development environment:

```sh
pnpm dev
```

This builds the core library and of the package variants, and starts a file watcher that will automatically rebuild each package when changes are made.

If you prefer, you can also start individual watchers from each package directory. For example:

```sh
cd packages/laravel-echo && pnpm dev
cd packages/react && pnpm dev
cd packages/svelte && pnpm dev
cd packages/vue && pnpm dev
```

> **Note:** The core package (`packages/laravel-echo`) must always be running, as all adapters depend on it.

## Running Tests

Run all tests:

```sh
pnpm test
```

Run the test suite for a specific adapter:

```sh
cd packages/laravel-echo && pnpm test
cd packages/react && pnpm test
cd packages/svelte && pnpm test
cd packages/vue && pnpm test
```

## Checks before a pull request (this fork)

CI (`.github/workflows/tests.yml`) runs these steps. To run them locally, from the root:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm run check:versions
node --test scripts/release.test.js
node scripts/release.js check --pack
pnpm run lint
pnpm exec vp fmt --check
pnpm -r --no-bail --if-present run test:compat
pnpm --filter @ably/laravel-echo exec tsc --noEmit -p tsconfig.json
pnpm --filter "@ably/laravel-echo-*" exec tsc --noEmit -p tsconfig.json
CI=true pnpm test
pnpm -r --no-bail --if-present run test:bundles
pnpm audit
```

- Build first: the lint, `test:compat` and `test:bundles` steps read the built `dist` folders.
- In a terminal, a plain `pnpm test` leaves the React, Vue and Svelte test runs in Vitest's watch mode, because their `test` script has no `--run` (as upstream). `CI=true pnpm test` runs every suite once.
- `pnpm exec vp fmt` fixes the formatting. `UPDATING.md`, `CHANGELOG-ABLY.md` and `.github/**` are not formatted.

CI also runs two suites against Ably's live sandbox. They create their own sandbox app, so they need no API keys:

- `pnpm --filter @ably/laravel-echo run test:sandbox` runs the live-sandbox tests.
- `pnpm --filter @ably/laravel-echo run test:browser-build` runs `packages/laravel-echo/tests/ably` against the browser build of `@ably/pubsub-device`, including the live-sandbox files. To run it locally without the sandbox, run the other files one at a time, because `vp test` treats `--exclude` as a file filter: for example `cd packages/laravel-echo && pnpm exec vp test --run --project browser-build tests/ably/auth-headers.test.ts`. The live-sandbox files are listed in `sandboxFiles` in `packages/laravel-echo/vite.config.ts`.

Never rely on `prepublish*` or `postpublish` scripts: setups with `ignore-scripts=true` skip them. Build explicitly with `pnpm build`, then check what the packages contain with `node scripts/release.js check --pack`, which packs all four and checks each tarball. `pnpm run check:versions` checks that the four versions and the adapters' peer range agree. Releases follow [RELEASE.md](RELEASE.md).

## Upstream re-syncs and fork deltas (this fork)

- The fork follows upstream `laravel/echo` 2.x. Upstream changes come in through a merge of upstream's `2.x` into this repository's `2.x` (never a rebase or a copy), reviewed as a pull request. The 1.x line (`master`) gets no upstream merges.
- A fork delta is any place where this fork deliberately differs from upstream, such as the native `ably` connector, the optional `broadcaster`, `Echo.onConnectionChange()` or the `.cjs` builds. The maintainers keep a registry of them, so that each re-sync keeps them. If your change adds or changes a fork delta, say so in your pull request.
- To keep re-syncs small: change upstream files only where you have to, and mark fork-specific code in them with a `fork` comment, as the existing code does. Put Ably-specific code and tests in separate files (for example `src/connector/ably-connector.ts`, `src/channel/ably/` and `tests/ably/`), and leave upstream's tests unchanged.

## Ignoring the formatting commit in `git blame` (optional, this fork)

The one-off oxfmt reformat of the Ably sources is listed in `.git-blame-ignore-revs`. GitHub applies it automatically. Locally, pass it per call with `git blame --ignore-revs-file .git-blame-ignore-revs <file>`. To make it the default in your own clone of the `2.x` line, opt in with `git config blame.ignoreRevsFile .git-blame-ignore-revs`. Note that `git blame` then fails on branches that do not have the file, such as the 1.x line.

## Contributing to this fork

- Keep every public method of the `Echo` and channel objects intact, whatever the internal implementation.
- Follow these steps to change the code:
    1. Fork the repository.
    2. Create your feature branch (`git checkout -b my-new-feature`).
    3. Commit your changes (`git commit -am 'Add some feature'`).
    4. Make sure you have added suitable tests and that the checks above pass (`CI=true pnpm test` runs the test suite once).
    5. Push to the branch (`git push origin my-new-feature`).
    6. Create a new pull request.
