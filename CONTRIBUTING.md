# Contributing

Thank you for your interest in contributing to Laravel Echo! Your contributions help make this project better for everyone.

Echo is maintained as a monorepo using [pnpm workspaces](https://pnpm.io/workspaces). Below you'll find an overview of the repository and how to get your development environment running.

> **Note:** You'll need **pnpm version 12 or higher**. If you're unsure which version you have, run `pnpm -v`.

**Prerequisites (this fork):** use Node 24.11 or later in the 24 line (see `.nvmrc`), Node 22.18 or later in the 22 line, or Node 26 or later (the Vite+ range `^22.18.0 || ^24.11.0 || >=26.0.0`, also in the root `engines`), and pnpm 12.3.4, which the root `packageManager` field pins. Get pnpm through corepack 0.34.5 or later, because older corepack releases, such as the 0.34.0 bundled with Node 22.19, cannot start pnpm 11 or later: run `npm i -g corepack@latest`, then `corepack enable`. Or install pnpm directly with `npm i -g pnpm@12.3.4`. Do not work around a version mismatch with `npm_config_manage_package_manager_versions=false`. Projects that use the published packages need only Node 22 or later.

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
git clone https://github.com/laravel/echo.git echo
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

## Ignoring the formatting commit in `git blame` (optional, this fork)

The one-off oxfmt reformat of the Ably sources is listed in `.git-blame-ignore-revs`. GitHub applies it automatically. Locally, pass it per call with `git blame --ignore-revs-file .git-blame-ignore-revs <file>`. To make it the default in your own clone of the `2.x` line, opt in with `git config blame.ignoreRevsFile .git-blame-ignore-revs`. Note that `git blame` then fails on branches that do not have the file, such as the 1.x line.
